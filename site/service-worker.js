/* Offline PWA shell. Network-first HTML prevents old pinned versions after GitHub Pages updates.
   No Web Push server or automatic background alarms are configured. */
const CACHE='jarvis-routine-v49.2-min-r8';
const SHELL=['./','./index.html','./premium.css?v=53','./wallpaper-visibility.css?v=6','./storage.js?v=1','./recur.js?v=1','./parse-ru.js?v=2','./schedule-bootstrap.js?v=1','./smart.js?v=23','./flex.js?v=2','./goals.js?v=3','./heatmap.js?v=1','./study.js?v=1','./vendor/fsrs.min.js','./ai.js?v=17','./chatstore.js?v=2','./ai.css','./ux-fixes.js?v=3','./calendar-nav.js?v=2','./calendar-nav.css?v=2','./focus-core.js?v=1','./focus.js?v=1','./quick.js?v=4','./planner.js?v=5','./memory.js?v=1','./copilot.js?v=2','./push.js?v=10','./vendor/three.r134.min.js','./vendor/vanta.waves.0.5.24.min.js','./vendor/fluid/fluid.js?v=1','./wallpaper.js?v=3','./vendor/third-party-licenses/THREE-LICENSE.txt','./vendor/third-party-licenses/VANTA-LICENSE.txt','./vendor/third-party-licenses/WEBGL-FLUID-LICENSE.txt','./manifest.webmanifest','./icon-192.png','./icon-512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)));self.skipWaiting()});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('jarvis-routine-')&&key!==CACHE).map(key=>caches.delete(key)))));self.clients.claim()});
self.addEventListener('fetch',event=>{
  const request=event.request;if(request.method!=='GET')return;
  const uri=new URL(request.url);if(uri.origin!==self.location.origin)return;
  const isPage=request.mode==='navigate'||uri.pathname.endsWith('/index.html')||uri.pathname.endsWith('/');
  if(isPage){event.respondWith(fetch(request).then(response=>{if(response.ok){let copy=response.clone();caches.open(CACHE).then(cache=>cache.put(request,copy));}return response;}).catch(async()=>await caches.match(request)||await caches.match('./index.html')));return;}
  event.respondWith(caches.match(request).then(hit=>hit||fetch(request).then(response=>{if(response.ok){let copy=response.clone();caches.open(CACHE).then(cache=>cache.put(request,copy));}return response;})));
});
self.addEventListener('notificationclick',event=>{event.notification.close();const d=event.notification.data||{},target=d.url||'./index.html';event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients=>{if(clients.length){const c=clients[0];try{c.navigate(target)}catch(e){}return c.focus()}return self.clients.openWindow(target)}))});

// Real background Web Push: shown immediately (required by Safari).
self.addEventListener('push', event=>{
  let msg={title:'JARVIS Routine',body:'Время следующего дела'};
  try{if(event.data)msg={...msg,...event.data.json()}}catch(e){if(event.data)msg.body=event.data.text()}
  event.waitUntil(self.registration.showNotification(msg.title,{body:msg.body,icon:'./icon-192.png',badge:'./icon-192.png',tag:'jr-reminder-'+Date.now(),data:{url:'./'}}));
});
