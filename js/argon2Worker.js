// Worker de dérivation Argon2.
//
// Pourquoi un worker : le calcul WebAssembly d'argon2-browser s'exécute d'un
// bloc et fige le fil principal pendant toute sa durée — plus d'une seconde sur
// PC, plusieurs sur téléphone. L'interface paraissait plantée pendant le
// déverrouillage. Ici le calcul se fait à côté, la page reste vivante.
//
// C'est un worker CLASSIQUE et non un worker de module, pour une raison
// précise : argon2-bundled.min.js est un bundle UMD dont l'enveloppe fait
// `(function (root, factory) { ... })(this, ...)`. Dans un module ES, `this`
// vaut `undefined` au niveau supérieur, et le bundle plante à l'initialisation.
// Un worker classique lui donne `self` comme `this`, ce qui est ce qu'il
// attend. Le repli @noble/hashes, lui, est un module ES : il est chargé par
// `import()` dynamique, disponible dans un worker classique.

/* global importScripts */

importScripts('./vendor/argon2-bundled.min.js');

// Version d'Argon2 câblée en dur par argon2-browser (lib/argon2.js :
// `const version = 0x13`). Pour un coffre en version 0x10 il donnerait un hash
// faux, donc un « mot de passe incorrect » sur une phrase pourtant juste.
const ARGON2_VERSION_WASM_ONLY = 0x13;
const TYPE_ARGON2ID = 2;

let noblePromise = null;
function noble() {
  if (!noblePromise) noblePromise = import('./vendor/noble-hashes/argon2.js');
  return noblePromise;
}

async function viaNoble(p) {
  const { argon2idAsync, argon2dAsync } = await noble();
  const fn = p.type === TYPE_ARGON2ID ? argon2idAsync : argon2dAsync;
  const hash = await fn(new Uint8Array(p.password), new Uint8Array(p.salt), {
    t: p.iterations,
    m: p.memory,      // déjà en kibioctets : kdbxweb divise par 1024 en amont
    p: p.parallelism,
    dkLen: p.length,
    version: p.version,
  });
  return new Uint8Array(hash);
}

async function viaWasm(p) {
  const res = await self.argon2.hash({
    pass: new Uint8Array(p.password),
    salt: new Uint8Array(p.salt),
    mem: p.memory,
    time: p.iterations,
    parallelism: p.parallelism,
    hashLen: p.length,
    type: p.type,
  });
  return new Uint8Array(res.hash);
}

self.onmessage = async (e) => {
  const p = e.data;
  let hash;
  let backend;

  try {
    if (typeof self.argon2 !== 'undefined' && p.version === ARGON2_VERSION_WASM_ONLY) {
      try {
        hash = await viaWasm(p);
        backend = 'wasm';
      } catch (err) {
        // WebAssembly indisponible à l'exécution (CSP, mémoire refusée) : le
        // coffre doit rester ouvrable, quitte à être plus lent.
        hash = await viaNoble(p);
        backend = 'js (repli après échec wasm)';
      }
    } else {
      hash = await viaNoble(p);
      backend = typeof self.argon2 === 'undefined' ? 'js (wasm absent)' : 'js (version 0x10)';
    }
  } catch (err) {
    self.postMessage({ id: p.id, ok: false, error: (err && err.message) || String(err) });
    return;
  }

  // Transfert du tampon plutôt que copie : le worker n'en a plus besoin.
  self.postMessage({ id: p.id, ok: true, hash: hash.buffer, backend }, [hash.buffer]);
};
