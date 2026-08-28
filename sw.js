// Service worker : réseau d'abord, repli sur le cache.
//
// IMPORTANT : incrémenter CACHE_NAME à chaque déploiement notable. L'événement
// 'activate' supprime tous les caches dont le nom diffère, ce qui force les
// appareils à repartir du réseau. Sans cela un téléphone peut servir une
// version ancienne indéfiniment.
//
// Particularité de ce projet par rapport à Gestion Loc SCI : le déverrouillage
// doit fonctionner SANS RÉSEAU. Toutes les dépendances nécessaires à
// l'ouverture du coffre (kdbxweb, Argon2) sont donc précachées ici et servies
// depuis la même origine. Une dépendance CDN serait ignorée par le filtre
// same-origin plus bas et casserait le mode hors ligne.
const CACHE_NAME = 'coffre-cache-2026082809';

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/vaultCrypto.js',
  './js/vaultDb.js',
  './js/vaultModel.js',
  './js/argon2Worker.js',
  './js/lockTimer.js',
  './js/clipboard.js',
  './diagnostic.html',
  './js/diagnostic.js',
  './js/generator.js',
  './js/mergeCycle.js',
  './js/backupPolicy.js',
  './js/keyWrap.js',
  './js/deviceKey.js',
  './js/vaultBackup.js',
  './js/vaultSync.js',
  './js/syncController.js',
  './js/firebaseInit.js',
  './js/firebaseAuth.js',
  './js/vendor/firebase/firebase-app.js',
  './js/vendor/firebase/firebase-auth.js',
  './js/vendor/firebase/firebase-storage.js',
  './js/vendor/eff-wordlist.json',
  './js/vendor/kdbxweb.min.js',
  './js/vendor/argon2-bundled.min.js',
  './js/vendor/noble-hashes/argon2.js',
  './js/vendor/noble-hashes/blake2.js',
  './js/vendor/noble-hashes/utils.js',
  './js/vendor/noble-hashes/_blake.js',
  './js/vendor/noble-hashes/_md.js',
  './js/vendor/noble-hashes/_u64.js',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // addAll est atomique : si un seul fichier manque, rien n'est mis en
      // cache. C'est voulu — un précache partiel donnerait une application qui
      // démarre hors ligne mais échoue au déverrouillage.
      cache.addAll(CORE_ASSETS)
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // Tout ce qui est cross-origin passe directement au réseau, sans cache.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => {
        if (cached) return cached;
        // Navigation hors ligne vers une URL non cachée : renvoyer la coquille.
        if (event.request.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      }))
  );
});
