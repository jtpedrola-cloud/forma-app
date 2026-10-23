/* Forma service worker. Runs the rest-timer notification on its own clock, so it still rings when the page is
   frozen in the background (Android throttles page timers with the screen off). No fetch handler on purpose: it
   never caches the app, so the self-update keeps working. */
let timer=null,stopRest=null,ftimer=null,fstop=null;
function clearFin(){if(ftimer){clearTimeout(ftimer);ftimer=null}if(fstop){const f=fstop;fstop=null;f()}}
function clearRest(){if(timer){clearTimeout(timer);timer=null}if(stopRest){const f=stopRest;stopRest=null;f()}}
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('message',e=>{
  const d=e.data||{};
  if(d.k==='restCancel'){clearRest();return}
  if(d.k==='finishCancel'){clearFin();return}
  if(d.k==='finish'){
    /* the still-training nudge: 20 minutes after the last set, only if no Forma window is open and visible */
    clearFin();
    const fms=Math.max(0,(+d.at||0)-Date.now());
    e.waitUntil(new Promise(res=>{
      fstop=res;
      ftimer=setTimeout(()=>{ftimer=null;fstop=null;self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{if(cs.some(c=>c.visibilityState==='visible'))return;
        return self.registration.showNotification('Still training?',{body:'Tap to finish your workout.',tag:'forma-finish',renotify:false,vibrate:[200,100,200],icon:'icon-192.png',data:{tab:'workout'}})}).then(res,res)},fms);
    }));
    return;
  }
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
self.addEventListener('notificationclick',e=>{const go=e.notification.tag==='forma-finish';e.notification.close();e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{const c=cs.find(x=>'focus' in x);if(c){if(go)c.postMessage({k:'goto',tab:'workout'});return c.focus()}return self.clients.openWindow(go?'./?tab=workout':'./')}))});
