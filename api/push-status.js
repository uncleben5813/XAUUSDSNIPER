import { Redis } from '@upstash/redis';

export default async function handler(req,res){
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});
  try{
    const redisConfigured=!!(process.env.KV_REST_API_URL&&process.env.KV_REST_API_TOKEN);
    const vapidPublicKeyConfigured=!!process.env.VAPID_PUBLIC_KEY;
    const vapidPrivateKeyConfigured=!!process.env.VAPID_PRIVATE_KEY;
    const vapidSubjectConfigured=!!process.env.VAPID_SUBJECT;
    let subscriptionCount=null;
    if(redisConfigured){
      const r=Redis.fromEnv();
      const list=await r.get('xau_push_subscriptions') || [];
      subscriptionCount=Array.isArray(list)?list.length:0;
    }
    return res.status(200).json({
      ok:true,
      webPush:{vapidPublicKeyConfigured,vapidPrivateKeyConfigured,vapidSubjectConfigured},
      redis:{configured:redisConfigured,subscriptionCount},
      ready:vapidPublicKeyConfigured&&vapidPrivateKeyConfigured&&redisConfigured
    });
  }catch(e){
    return res.status(500).json({ok:false,error:e.message});
  }
}
