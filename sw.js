/* Forma service worker. Runs the rest-timer notification on its own clock, so it still rings when the page is
   frozen in the background (Android throttles page timers with the screen off). No fetch handler on purpose: it
   never caches the app, so the self-update keeps working. */
let timer=null,stopRest=null;
function clearRest(){if(timer){clearTimeout(timer);timer=null}if(stopRest){const f=stopRest;stopRest=null;f()}}
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('message',e=>{
  const d=e.data||{};
  if(d.k==='restCancel'){clearRest();return}
  if(d.k!=='rest')return;
  clearRest();
  const ms=Math.max(0,(+d.end||0)-Date.now());
  /* waitUntil keeps the worker alive until the timer fires or is cancelled */
  e.waitUntil(new Promise(res=>{
    stopRest=res;
    timer=setTimeout(()=>{timer=null;stopRest=null;self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{if(!d.test&&cs.some(c=>c.visibilityState==='visible'))return;
      return self.registration.showNotification('Rest over',{body:d.test?'This is a test. Rest notifications work.':(d.name?d.name+': ':'')+'time for your next set.',tag:'forma-rest',renotify:false,vibrate:[300,120,300,120,300],icon:'icon-192.png'})}).then(res,res)},ms);
  }));
});
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{const c=cs.find(x=>'focus' in x);return c?c.focus():self.clients.openWindow('./')}))});
