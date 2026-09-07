const CACHE='jimmy-paul-room-v3';
const root=new URL('./',self.location.href).pathname;
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(['','assets/join-demo.png','assets/join-live.png','assets/book.png','fallback.html','downloads/PHONE-ROOM-FALLBACK-CARDS.pdf'].map(x=>root+x))));self.skipWaiting()});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('message',e=>{if(e.data?.type==='warm')e.waitUntil(caches.open(CACHE).then(c=>Promise.all((e.data.assets||[]).filter(u=>new URL(u).origin===self.location.origin&&!u.includes('/api/')).map(u=>c.add(u).catch(()=>{}))))) });
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/api/'))return;
if(e.request.mode==='navigate'){e.respondWith(Promise.race([fetch(e.request),new Promise((_,reject)=>setTimeout(()=>reject(new Error('offline')),3500))]).catch(()=>caches.match(e.request).then(hit=>hit||caches.match('/'))));return;}
if(/\.(js|css|ttf|woff2?|png|jpg|jpeg)$/.test(u.pathname))e.respondWith(caches.match(e.request).then(hit=>hit||fetch(e.request).then(r=>{if(r.ok)caches.open(CACHE).then(c=>c.put(e.request,r.clone()));return r})));});
