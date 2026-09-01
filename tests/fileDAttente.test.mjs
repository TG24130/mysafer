// Tests de la file d'attente qui sérialise les accès au coffre.
//
// Ce qu'elle empêche, en une phrase : deux `db.save()` de kdbxweb entrelacés,
// qui produisent un fichier dont l'en-tête ne correspond plus au corps. Le
// symptôme, vécu deux fois le 2026-09-01, est « invalid gzip data » à la
// lecture suivante — puis, une fois l'état abîmé, « MergeError: duplicate ».
//
// Le scénario reproduit ici est exactement celui de l'incident : un
// enregistrement lancé pendant qu'un cycle de synchronisation sérialise déjà.
//
// Lancer :  node tests/fileDAttente.test.mjs

import assert from 'node:assert/strict';
import { creerFile } from '../js/fileDAttente.js';

let ok = 0;
const queue = [];
function test(nom, fn) { queue.push([nom, fn]); }

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('Exclusion mutuelle', null);

test('deux travaux ne se chevauchent jamais', async () => {
  const enfiler = creerFile();
  let enCours = 0;
  let chevauchements = 0;

  const travail = async () => {
    enCours += 1;
    if (enCours > 1) chevauchements += 1;
    await pause(10);
    enCours -= 1;
  };

  await Promise.all([enfiler(travail), enfiler(travail), enfiler(travail)]);
  assert.equal(chevauchements, 0);
});

test('l’ordre d’enfilement est respecté', async () => {
  const enfiler = creerFile();
  const trace = [];
  const travail = (nom, ms) => () => pause(ms).then(() => { trace.push(nom); });

  await Promise.all([
    enfiler(travail('a', 30)),
    enfiler(travail('b', 1)),
    enfiler(travail('c', 1)),
  ]);
  assert.deepEqual(trace, ['a', 'b', 'c']);
});

test('Robustesse', null);

// Sans cela, une synchronisation en panne empêcherait tout enregistrement
// ultérieur : le remède serait pire que le mal.
test('un travail en échec ne bloque pas la file', async () => {
  const enfiler = creerFile();
  const trace = [];

  const rate = enfiler(async () => { throw new Error('panne'); });
  await assert.rejects(() => rate, /panne/);

  await enfiler(async () => { trace.push('suivant'); });
  assert.deepEqual(trace, ['suivant']);
});

test('l’erreur revient bien à celui qui a enfilé le travail', async () => {
  const enfiler = creerFile();
  const cause = new Error('précise');
  await assert.rejects(() => enfiler(async () => { throw cause; }), (e) => e === cause);
});

test('la valeur de retour est transmise', async () => {
  const enfiler = creerFile();
  assert.equal(await enfiler(async () => 42), 42);
});

test('Le scénario de l’incident', null);

// Un cycle de synchronisation sérialise (lent : deux dérivations Argon2), et
// l'utilisateur enregistre une entrée pendant ce temps. Sans file, les deux
// sérialisations se chevauchent.
test('un enregistrement lancé pendant une synchronisation attend son tour', async () => {
  const enfiler = creerFile();
  const journal = [];
  let serialisationsSimultanees = 0;
  let pic = 0;

  const serialiser = async (qui) => {
    serialisationsSimultanees += 1;
    pic = Math.max(pic, serialisationsSimultanees);
    journal.push(qui + ':début');
    await pause(20);
    journal.push(qui + ':fin');
    serialisationsSimultanees -= 1;
  };

  const synchro = enfiler(() => serialiser('synchro'));
  await pause(5);                                  // l'utilisateur enregistre
  const enregistrement = enfiler(() => serialiser('enregistrement'));

  await Promise.all([synchro, enregistrement]);

  assert.equal(pic, 1, 'deux sérialisations ont eu lieu en même temps');
  assert.deepEqual(journal, [
    'synchro:début', 'synchro:fin',
    'enregistrement:début', 'enregistrement:fin',
  ]);
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
