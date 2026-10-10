/* Kitty Manager service worker: keeps the app opening with no internet. Sign-in and sharing still need internet. */
var VERSION='km-2',SHELL=['./','index.html','shim.js','manifest.webmanifest','firebase-config.js','icon-192.png','icon-512.png'];
self.addEventListener('install',function(e){e.waitUntil(caches.open(VERSION).then(function(c){return c.addAll(SHELL);}).then(function(){return self.skipWaiting();}));});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==VERSION;}).map(function(k){return caches.delete(k);}));}).then(function(){return self.clients.claim();}));});
self.addEventListener('fetch',function(e){
  var u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin)return;
  e.respondWith(fetch(e.request).then(function(r){var c=r.clone();caches.open(VERSION).then(function(x){x.put(e.request,c);});return r;}).catch(function(){return caches.match(e.request).then(function(m){return m||caches.match('index.html');});}));
});
