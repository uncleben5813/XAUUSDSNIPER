self.addEventListener('push', event => {
  let data={};
  try{ data=event.data ? event.data.json() : {}; }catch(e){ data={body:event.data?.text?.()||''}; }
  const title=data.title || 'XAU/USD Signal';
  const options={
    body:data.body || 'Signal detected',
    icon:'/icon.png',
    badge:'/icon.png',
    tag:'xau-signal',
    renotify:true,
    data:{url:data.url||'/'}
  };
  event.waitUntil(self.registration.showNotification(title,options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url=event.notification.data?.url || '/';
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    for(const client of list){ if('focus' in client) return client.focus(); }
    if(clients.openWindow) return clients.openWindow(url);
  }));
});
