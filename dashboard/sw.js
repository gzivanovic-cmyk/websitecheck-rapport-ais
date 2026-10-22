/* Service worker van het AIS-dashboard (rapport.ais-groep.nl/dashboard): toont de pushmeldingen over AIS-website-checks
   ({titel, tekst, url, nieuw} van websitecheck-push.php, app=ais), zet het rode getal op het app-icoon en opent het dashboard
   bij een tik op de melding. Het getal staat in IndexedDB (ais-dashboard / kv / badge); het dashboard zet het op 0 bij openen. */
function teller(doe) {
  return new Promise(function (klaar) {
    var r = indexedDB.open('ais-dashboard', 1);
    r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
    r.onerror = function () { klaar(0); };
    r.onsuccess = function () {
      var tx = r.result.transaction('kv', 'readwrite'), st = tx.objectStore('kv'), q = st.get('badge'), n = 0;
      q.onsuccess = function () { n = doe(q.result || 0); st.put(n, 'badge'); };
      tx.oncomplete = function () { r.result.close(); klaar(n); };
      tx.onerror = function () { klaar(0); };
    };
  });
}
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = {}; }
  var toon = self.registration.showNotification(d.titel || 'Nieuwe website-check', {
    body: d.tekst || 'Er is via ais-groep.nl een website-check aangevraagd.', icon: 'assets/icoon-192.png', badge: 'assets/icoon-192.png',
    tag: 'ais-' + Date.now(), data: { url: d.url || './' }
  });
  var getal = d.nieuw !== false && self.navigator && self.navigator.setAppBadge
    ? teller(function (n) { return n + 1; }).then(function (n) { return self.navigator.setAppBadge(n); }).catch(function () {})
    : Promise.resolve();
  var seintje = self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (vensters) {
    vensters.forEach(function (w) { w.postMessage({ vernieuw: true }); });
  }).catch(function () {});
  e.waitUntil(Promise.all([toon, getal, seintje]));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  // het dashboard staat in een map van rapport.ais-groep.nl: altijd binnen die map openen, alleen het #check-deel van de link telt
  var url = (e.notification.data && e.notification.data.url) || '';
  url = self.registration.scope + (url.indexOf('#') !== -1 ? url.slice(url.indexOf('#')) : '');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (vensters) {
    for (var i = 0; i < vensters.length; i++) {
      var w = vensters[i];
      if ('focus' in w && w.url.indexOf(self.registration.scope) === 0) {
        if (url.indexOf('#check=') !== -1) { w.postMessage({ open: url.split('#check=')[1] }); }
        return w.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
