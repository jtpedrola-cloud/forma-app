/* Pulzo service worker. Two jobs: (1) the rest-timer and still-training notifications run on its own clock, so they
   still ring when the page is frozen in the background (Android throttles page timers with the screen off);
   (2) an offline shell: the page, scripts, icons and the lib JSON are cached so the app opens with no signal.
   The cache name carries the build stamp the page was published with (the same value as version.txt), so a new
   publish starts a fresh cache and old ones are deleted. The page itself is always network first, which keeps the
   self-update (checkVersion) working; static files are cache first once a real build stamp is known. Cross-origin
   requests (GitHub, Supabase, exercise pictures) are never touched. */
const PREFIX='forma-shell-',META='forma-meta';
const SHELL=['smart.js','plan.js','copy.js','cmd.js','ai.js','backend.js','tour.js','manifest.webmanifest?v=4','icon.svg?v=4','apple-touch-icon.png?v=4','icon-192.png','icon-512.png','icon-maskable-192.png','icon-maskable-512.png','lib/exercises.json','lib/foods.json','lib/lessons.json'];
const abs=u=>new URL(u,self.registration.scope).href;
const PAGE=abs('index.html');
const real=v=>!!v&&v!=='dev'&&!v.startsWith('__');
async function curVer(){const m=await caches.open(META),r=await m.match('ver');return r?r.text():null}
async function setVer(v){
  const m=await caches.open(META);await m.put('ver',new Response(v));
  const keep=PREFIX+v;(await caches.keys()).forEach(k=>{if(k.startsWith(PREFIX)&&k!==keep)caches.delete(k)});
}
const stamp=t=>{const m=/const BUILD='([^']+)'/.exec(t);return m?m[1]:'dev'};
async function learn(res){
  const v=stamp(await res.clone().text());
  if(v!==await curVer())await setVer(v);
  await (await caches.open(PREFIX+v)).put(PAGE,res.clone());
  return v;
}
async function precache(){
  try{
    const res=await fetch(PAGE,{cache:'no-cache'});if(!res.ok)return;
    const v=await learn(res);if(!real(v))return;
    const c=await caches.open(PREFIX+v);
    await Promise.allSettled(SHELL.map(async u=>{const r=await fetch(abs(u),{cache:'no-cache'});if(r.ok)await c.put(abs(u),r)}));
  }catch(e){}
}
async function shellCache(){const v=await curVer();return v?caches.open(PREFIX+v):null}
async function page(){
  try{
    const res=await fetch(PAGE,{cache:'no-cache'});
    if(res.ok){try{await learn(res)}catch(x){}return res}
  }catch(x){}
  const c=await shellCache(),hit=c&&await c.match(PAGE);
  return hit||new Response('<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px system-ui;padding:24px;background:#101114;color:#eee">Pulzo has not been opened on this phone with a connection yet. Connect once, then it opens without a signal.',{status:503,headers:{'content-type':'text/html'}});
}
async function asset(r){
  const c=await shellCache(),v=await curVer(),hit=c&&await c.match(r);
  const lib=new URL(r.url).pathname.includes('/lib/');
  if(hit&&real(v)&&!lib)return hit;
  try{
    const res=await fetch(r,{cache:'no-cache'});
    if(res.status===200&&c)c.put(r,res.clone());
    return res;
  }catch(x){if(hit)return hit;throw x}
}
self.addEventListener('fetch',e=>{
  const r=e.request;if(r.method!=='GET')return;
  const u=new URL(r.url);if(!u.href.startsWith(self.registration.scope))return;
  if(u.pathname.endsWith('/version.txt')||u.pathname.endsWith('/sw.js')||r.headers.has('range'))return;
  e.respondWith(r.mode==='navigate'?page():asset(r));
});
let timer=null,stopRest=null,ftimer=null,fstop=null;
function clearFin(){if(ftimer){clearTimeout(ftimer);ftimer=null}if(fstop){const f=fstop;fstop=null;f()}}
function clearRest(){if(timer){clearTimeout(timer);timer=null}if(stopRest){const f=stopRest;stopRest=null;f()}}
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(precache())});
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('message',e=>{
  const d=e.data||{};
  if(d.k==='restCancel'){clearRest();return}
  if(d.k==='finishCancel'){clearFin();return}
  if(d.k==='finish'){
    /* the still-training nudge: 20 minutes after the last set, only if no Pulzo window is open and visible */
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
