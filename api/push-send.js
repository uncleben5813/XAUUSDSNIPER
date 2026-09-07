import webpush from 'web-push';
import { Redis } from '@upstash/redis';

function redis(){ return Redis.fromEnv(); }
function setup(){
  const subject=process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  webpush.setVapidDetails(subject,process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);
}

export default async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  try{
    if(!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) throw new Error('VAPID keys missing');
    setup();
    const body=typeof req.body==='string'?JSON.parse(req.body):req.body||{};
    const payload=JSON.stringify({
      title:body.title || 'XAU/USD Signal',
      body:body.body || 'Signal detected',
      url:body.url || '/',
      signal:body.signal || '',
      signalType:body.signalType || ''
    });
    const r=redis();
    const key='xau_push_subscriptions';
    const list=await r.get(key) || [];
    let sent=0, removed=0;
    const alive=[];
    for(const sub of list){
      try{
        await webpush.sendNotification(sub,payload);
        sent++;
        alive.push(sub);
      }catch(e){
        if(e.statusCode===404 || e.statusCode===410){ removed++; }
        else { console.warn('push delivery failed',e.statusCode,e.message); alive.push(sub); }
      }
    }
    await r.set(key,alive);
    return res.status(200).json({ok:true,sent,removed,total:alive.length});
  }catch(e){
    console.error('push-send',e);
    return res.status(500).json({error:e.message});
  }
}
