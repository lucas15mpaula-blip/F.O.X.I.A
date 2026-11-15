/* F.O.X.I.A Service Worker — offline + sync + push */
const CACHE = 'foxia-v4';

function swIcon(name){
  try{
    return new URL(name||'icon-192.png', self.registration.scope).href;
  }catch(e){
    return './icon-192.png';
  }
}

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './sw.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* --- Offline Support: cache-first para shell; network-first para HTML --- */
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (/workers\.dev|googleapis|groq|openai|anthropic|elevenlabs|canva\.com/i.test(url.href)) return;

  const isShell =
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.webmanifest') ||
    url.pathname.endsWith('sw.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.js');

  if (isShell) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  /* HTML / navegação: rede primeiro, offline cai no cache */
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || caches.match('./index.html') || caches.match('./'))
      )
  );
});

/* --- Background Sync: reprocessa fila quando a rede volta --- */
self.addEventListener('sync', (e) => {
  if (e.tag === 'foxia-sync' || e.tag === 'foxia-bg') {
    e.waitUntil(flushQueue());
  }
});

async function flushQueue() {
  let items = [];
  try {
    const raw = await idbGet('foxia_sync_queue');
    items = raw ? JSON.parse(raw) : [];
  } catch (e) {
    items = [];
  }
  if (!items.length) {
    await notifyClients({ type: 'sync-done', count: 0 });
    return;
  }
  const left = [];
  for (const it of items) {
    try {
      if (it.type === 'notify') {
        await self.registration.showNotification(it.title || 'F.O.X.I.A', {
          body: it.body || '',
          icon: swIcon('icon-192.png'),
          badge: swIcon('icon-192.png'),
          tag: it.tag || 'foxia-sync',
          data: { url: it.url || './' }
        });
      } else if (it.type === 'fetch' && it.url) {
        await fetch(it.url, {
          method: it.method || 'POST',
          headers: it.headers || { 'content-type': 'application/json' },
          body: it.body || null
        });
      }
    } catch (e) {
      left.push(it);
    }
  }
  await idbSet('foxia_sync_queue', JSON.stringify(left));
  await notifyClients({ type: 'sync-done', count: items.length - left.length });
}

/* --- Periodic Sync: lembrete / atualização em intervalo (quando o SO permitir) --- */
self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'foxia-periodic') {
    e.waitUntil(
      (async () => {
        await notifyClients({ type: 'periodic-sync' });
        try {
          await self.registration.showNotification('F.O.X.I.A', {
            body: 'Sincronização periódica — abra o app se quiser conversar.',
            icon: swIcon('icon-192.png'),
            tag: 'foxia-periodic',
            data: { url: './' }
          });
        } catch (err) {}
      })()
    );
  }
});

/* --- Push Notifications --- */
self.addEventListener('push', (e) => {
  let data = { title: 'F.O.X.I.A', body: 'Nova mensagem', url: './' };
  try {
    if (e.data) {
      const j = e.data.json();
      data = Object.assign(data, j);
    }
  } catch (err) {
    try {
      data.body = e.data.text();
    } catch (e2) {}
  }
  e.waitUntil(
    self.registration.showNotification(data.title || 'F.O.X.I.A', {
      body: data.body || '',
      icon: data.icon || swIcon('icon-192.png'),
      badge: swIcon('icon-192.png'),
      tag: data.tag || 'foxia-push',
      data: { url: data.url || './' },
      renotify: true
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          try {
            c.postMessage({ type: 'notification-click' });
          } catch (err) {}
          return c.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

/* Mensagens da página */
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'notify' && d.title) {
    e.waitUntil(
      self.registration.showNotification(d.title, {
        body: d.body || '',
        icon: swIcon('icon-192.png'),
        badge: swIcon('icon-192.png'),
        data: { url: d.url || './' },
        tag: d.tag || 'foxia',
        renotify: !!d.renotify
      })
    );
  }
  if (d.type === 'queue-sync') {
    e.waitUntil(
      (async () => {
        let items = [];
        try {
          const raw = await idbGet('foxia_sync_queue');
          items = raw ? JSON.parse(raw) : [];
        } catch (err) {
          items = [];
        }
        items.push(d.item || d);
        await idbSet('foxia_sync_queue', JSON.stringify(items.slice(-30)));
        try {
          await self.registration.sync.register('foxia-sync');
        } catch (err) {}
      })()
    );
  }
  if (d.type === 'skipWaiting') self.skipWaiting();
});

async function notifyClients(msg) {
  const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of list) {
    try {
      c.postMessage(msg);
    } catch (e) {}
  }
}

/* Mini IDB para a fila de sync */
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('foxia-sw', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function idbGet(key) {
  return idbOpen().then(
    (db) =>
      new Promise((res, rej) => {
        const tx = db.transaction('kv', 'readonly');
        const g = tx.objectStore('kv').get(key);
        g.onsuccess = () => res(g.result || null);
        g.onerror = () => rej(g.error);
      })
  );
}
function idbSet(key, val) {
  return idbOpen().then(
    (db) =>
      new Promise((res, rej) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(val, key);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      })
  );
}
