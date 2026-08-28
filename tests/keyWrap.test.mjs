// Tests de l'emballage de la phrase maîtresse (js/keyWrap.js).
//
// Ce code protège la phrase de passe stockée sur l'appareil pour le
// déverrouillage biométrique. Il n'a besoin ni de WebAuthn ni de navigateur :
// il reçoit un secret brut, ce qui permet de le tester sous Node, où WebCrypto
// existe. Le secret est ici fabriqué à la main, comme le ferait
// l'authentificateur.
//
// Lancer :  node tests/keyWrap.test.mjs

import assert from 'node:assert/strict';
import { emballer, deballer, versBase64, depuisBase64 } from '../js/keyWrap.js';

// Node expose btoa/atob et WebCrypto globalement depuis la version 18, mais le
// module vise le navigateur : on ne suppose rien et on vérifie.
assert.ok(globalThis.crypto && globalThis.crypto.subtle, 'WebCrypto requis');
assert.ok(typeof btoa === 'function' && typeof atob === 'function', 'btoa/atob requis');

let ok = 0;
const queue = [];
const test = (nom, fn) => queue.push([nom, fn]);
const section = (titre) => queue.push([titre, null]);

/** Faux secret d'appareil : 32 octets, comme une sortie PRF. */
const secret = (remplissage) => new Uint8Array(32).fill(remplissage);

const PHRASE = 'cheval.batterie.agrafe.correct.tuile.orage';

section('Encodage');

test('base64 fait l’aller-retour sans perte', () => {
  const octets = new Uint8Array([0, 1, 127, 128, 255, 42]);
  assert.deepEqual([...depuisBase64(versBase64(octets))], [...octets]);
});

section('Emballage');

test('une phrase emballée se déballe à l’identique', async () => {
  const s = secret(7);
  const paquet = await emballer(PHRASE, s);
  assert.equal(await deballer(paquet, s), PHRASE);
});

test('le paquet ne contient la phrase sous aucune forme lisible', async () => {
  const paquet = await emballer(PHRASE, secret(7));
  const serialise = JSON.stringify(paquet);
  assert.ok(!serialise.includes(PHRASE), 'la phrase ne doit pas apparaître en clair');
  assert.ok(!serialise.includes('cheval'), 'ni aucun de ses mots');
  // Le paquet doit être sérialisable tel quel pour IndexedDB.
  assert.deepEqual(Object.keys(paquet).sort(), ['contenu', 'iv', 'sel', 'version']);
});

test('deux emballages de la même phrase diffèrent', async () => {
  // Sel et IV aléatoires à chaque fois : sans cela, deux coffres identiques
  // produiraient le même paquet, ce qui renseignerait un observateur.
  const s = secret(7);
  const a = await emballer(PHRASE, s);
  const b = await emballer(PHRASE, s);
  assert.notEqual(a.contenu, b.contenu);
  assert.notEqual(a.sel, b.sel);
  assert.notEqual(a.iv, b.iv);
  // Et les deux restent déballables.
  assert.equal(await deballer(a, s), PHRASE);
  assert.equal(await deballer(b, s), PHRASE);
});

test('les phrases accentuées et longues survivent', async () => {
  // La liste EFF est en anglais (décision 5), mais rien n'empêche une phrase
  // saisie à la main. Un encodage mal fait s'y casserait.
  const s = secret(3);
  for (const p of ['éàüç ñ 日本語 🔐', 'x'.repeat(4096), '']) {
    assert.equal(await deballer(await emballer(p, s), s), p);
  }
});

section('Refus');

test('un mauvais secret échoue franchement', async () => {
  // Point important : AES-GCM est authentifié, donc un secret faux échoue au
  // lieu de rendre une phrase erronée. Sans cela, l'utilisateur verrait
  // « phrase de passe incorrecte » sans comprendre pourquoi.
  const paquet = await emballer(PHRASE, secret(7));
  await assert.rejects(
    () => deballer(paquet, secret(8)),
    /ne correspond pas/,
  );
});

test('un paquet altéré est rejeté', async () => {
  const s = secret(7);
  const paquet = await emballer(PHRASE, s);

  const octets = depuisBase64(paquet.contenu);
  octets[0] ^= 0xff;
  const altere = { ...paquet, contenu: versBase64(octets) };

  await assert.rejects(() => deballer(altere, s), /ne correspond pas/);
});

test('un paquet absent ou de version inconnue est refusé', async () => {
  const s = secret(7);
  await assert.rejects(() => deballer(null, s), /absent ou de version inconnue/);
  await assert.rejects(() => deballer({ version: 2 }, s), /absent ou de version inconnue/);
});

// --- Exécution --------------------------------------------------------------

for (const [nom, fn] of queue) {
  if (fn === null) { console.log('\n' + nom); continue; }
  try {
    await fn();
    ok++;
    console.log('  ok   ' + nom);
  } catch (e) {
    console.error('  ECHEC ' + nom + '\n        ' + e.message);
    process.exitCode = 1;
  }
}
console.log(`\n${ok} tests passés.`);
