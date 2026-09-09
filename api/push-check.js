import webpush from 'web-push';
import { Redis } from '@upstash/redis';

function authOk(req){
  const secret=process.env.CRON_SECRET;
  if(!secret) return true;
  return req.headers.authorization===`Bearer ${secret}`;
}
function redis(){ return Redis.fromEnv(); }
function setup(){ webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com',process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY); }

export default async function handler(req,res){
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});
  if(!authOk(req)) return res.status(401).json({error:'Unauthorized'});
  try{
    if(!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) throw new Error('VAPID keys missing');
    if(!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) throw new Error('KV_REST_API_URL/KV_REST_API_TOKEN missing');
    setup();
    const base=`https://${req.headers.host}`;
    const api=await fetch(`${base}/api/scalp?ts=${Date.now()}`,{cache:'no-store'});
    const data=await api.json();
    if(!data.ok) throw new Error(data.error||'SCALP API error');
    const signal=String(data.signal||'WAIT').toUpperCase();
    const signalType=String(data.signalType||'NONE').toUpperCase();
    if(signal==='WAIT') return res.status(200).json({ok:true,signal,notified:false,reason:'WAIT'});

    const price=Number(data.livePrice?.price ?? data.price ?? 0);
    const score=Number(data.score ?? 0);
    const r=redis();
    const stateKey='xau_push_last_signal';
    const current=`${signal}|${signalType}`;
    const last=await r.get(stateKey);
    if(last===current) return res.status(200).json({ok:true,signal,signalType,notified:false,deduped:true});

    const title=`${signal==='BUY'?'🟢':'🔴'} XAU/USD ${signal} ${signalType}`;
    const body=`Price ${price.toFixed(2)} • Score ${score}/100 • ${signalType}`;
    const list=await r.get('xau_push_subscriptions') || [];
    let sent=0, removed=0;
    const alive=[];
    for(const sub of list){
      try{
        await webpush.sendNotification(sub,JSON.stringify({title,body,url:'/',signal,signalType}));
        sent++; alive.push(sub);
      }catch(e){
        if(e.statusCode===404||e.statusCode===410) removed++;
        else alive.push(sub);
      }
    }
    await r.set('xau_push_subscriptions',alive);
    if(sent>0) await r.set(stateKey,current,{ex:86400});
    return res.status(200).json({ok:true,signal,signalType,notified:sent>0,sent,removed,total:alive.length});
  }catch(e){
    console.error('push-check',e);
    return res.status(500).json({error:e.message});
  }
}
