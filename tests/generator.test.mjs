// Tests du générateur de secrets (js/generator.js).
//
// Tournent sans navigateur ni réseau. La liste de mots est lue depuis le
// disque et injectée, parce que `fetch` d'une URL relative n'a pas de sens
// sous Node.
//
// Lancer :  node tests/generator.test.js
//
// Ces tests portent sur des propriétés statistiques, pas sur des valeurs
// figées : un générateur aléatoire n'a pas de sortie attendue. Ce qu'on
// vérifie, c'est l'absence de biais, l'usage exclusif du CSPRNG et le respect
// des contraintes annoncées.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

import {
  randomBelow, pick, generatePassphrase, generatePassword,
  passphraseBits, passwordBits, CHARSETS, DEFAULT_SEPARATOR,
} from '../js/generator.js';

const here = dirname(fileURLToPath(import.meta.url));
const WORDS = JSON.parse(readFileSync(join(here, '..', 'js', 'vendor', 'eff-wordlist.json'), 'utf8'));

let ok = 0;
function test(nom, fn) {
  try {
    fn();
    ok++;
    console.log('  ok   ' + nom);
  } catch (e) {
    console.error('  ECHEC ' + nom + '\n        ' + e.message);
    process.exitCode = 1;
  }
}
async function testAsync(nom, fn) {
  try {
    await fn();
    ok++;
    console.log('  ok   ' + nom);
  } catch (e) {
    console.error('  ECHEC ' + nom + '\n        ' + e.message);
    process.exitCode = 1;
  }
}

console.log('\nListe de mots');

test('exactement 7776 mots, tous uniques', () => {
  assert.equal(WORDS.length, 7776);
  assert.equal(new Set(WORDS).size, 7776);
});

test('6 mots donnent bien ~77,5 bits', () => {
  const bits = passphraseBits(6, WORDS.length);
  assert.ok(bits > 77.4 && bits < 77.6, 'bits = ' + bits);
});

console.log('\nTirage aléatoire');

test('randomBelow reste dans [0, max[', () => {
  for (let i = 0; i < 5000; i++) {
    const v = randomBelow(7776);
    assert.ok(Number.isInteger(v) && v >= 0 && v < 7776, 'valeur hors bornes : ' + v);
  }
});

test('randomBelow refuse les bornes absurdes', () => {
  for (const bad of [0, -1, 1.5, NaN]) {
    assert.throws(() => randomBelow(bad), RangeError, 'aurait dû refuser ' + bad);
  }
});

test('randomBelow ne montre pas de biais grossier', () => {
  // 60 000 tirages sur 6 valeurs : chaque case attendue à 10 000. Un modulo
  // biaisé sur un petit domaine ne se verrait pas ici, mais un générateur
  // franchement cassé (constante, tronqué, mal borné) oui.
  const n = 60000, k = 6;
  const counts = new Array(k).fill(0);
  for (let i = 0; i < n; i++) counts[randomBelow(k)]++;
  const attendu = n / k;
  for (const c of counts) {
    const ecart = Math.abs(c - attendu) / attendu;
    assert.ok(ecart < 0.06, 'écart de ' + (ecart * 100).toFixed(1) + '% : ' + counts.join(', '));
  }
});

test('pick couvre tout le domaine', () => {
  const vus = new Set();
  for (let i = 0; i < 3000; i++) vus.add(pick(['a', 'b', 'c', 'd', 'e']));
  assert.equal(vus.size, 5);
});

console.log('\nPhrases de passe');

await testAsync('6 mots par défaut', async () => {
  const p = await generatePassphrase(6, DEFAULT_SEPARATOR, WORDS);
  assert.equal(p.split(DEFAULT_SEPARATOR).length, 6);
});

await testAsync('tous les mots viennent de la liste', async () => {
  const set = new Set(WORDS);
  for (let i = 0; i < 200; i++) {
    for (const mot of (await generatePassphrase(6, DEFAULT_SEPARATOR, WORDS)).split(DEFAULT_SEPARATOR)) {
      assert.ok(set.has(mot), 'mot hors liste : ' + mot);
    }
  }
});

await testAsync('deux phrases consécutives diffèrent', async () => {
  const a = await generatePassphrase(6, DEFAULT_SEPARATOR, WORDS);
  const b = await generatePassphrase(6, DEFAULT_SEPARATOR, WORDS);
  assert.notEqual(a, b);
});

await testAsync('le nombre de mots est respecté', async () => {
  for (const n of [1, 4, 6, 10]) {
    assert.equal((await generatePassphrase(n, ' ', WORDS)).split(' ').length, n);
  }
});

await testAsync('le séparateur par défaut ne coupe aucun mot composé', async () => {
  // La liste EFF contient drop-down, felt-tip, t-shirt et yo-yo. Avec un tiret
  // comme séparateur, une phrase de 6 mots pouvait se relire comme 7.
  const composes = WORDS.filter((w) => !/^[a-z]+$/.test(w));
  assert.ok(composes.length > 0, 'la liste devrait contenir des mots composés');
  for (const w of composes) {
    assert.ok(!w.includes(DEFAULT_SEPARATOR), 'mot contenant le séparateur : ' + w);
  }
});

await testAsync('refuse un séparateur présent dans la liste', async () => {
  await assert.rejects(() => generatePassphrase(6, '-', WORDS), /séparateur invalide/);
  await assert.rejects(() => generatePassphrase(6, '', WORDS), /séparateur invalide/);
});

await testAsync('refuse un nombre de mots hors limites', async () => {
  for (const bad of [0, -3, 25, 2.5]) {
    await assert.rejects(() => generatePassphrase(bad, DEFAULT_SEPARATOR, WORDS), RangeError);
  }
});

console.log('\nMots de passe');

test('longueur respectée', () => {
  for (const n of [8, 20, 64]) {
    assert.equal(generatePassword(n).length, n);
  }
});

test('au moins un caractère de chaque jeu demandé', () => {
  const sets = ['minuscules', 'majuscules', 'chiffres', 'symboles'];
  for (let i = 0; i < 300; i++) {
    const p = generatePassword(12, sets, true);
    for (const s of sets) {
      assert.ok([...p].some((c) => CHARSETS[s].includes(c)), 'jeu absent : ' + s + ' dans ' + p);
    }
  }
});

test('aucun caractère hors des jeux demandés', () => {
  const sets = ['minuscules', 'chiffres'];
  const permis = CHARSETS.minuscules + CHARSETS.chiffres;
  for (let i = 0; i < 300; i++) {
    for (const c of generatePassword(16, sets, true)) {
      assert.ok(permis.includes(c), 'caractère interdit : ' + c);
    }
  }
});

test('les jeux non ambigus excluent l, I, 1, O, 0', () => {
  for (const c of ['l', 'I', '1', 'O', '0']) {
    const dans = CHARSETS.minuscules + CHARSETS.majuscules + CHARSETS.chiffres;
    assert.ok(!dans.includes(c), 'caractère ambigu présent : ' + c);
  }
});

test('les caractères imposés ne restent pas en tête', () => {
  // Sans mélange, generatePassword placerait un symbole en position 3 à chaque
  // fois. On vérifie que la position du symbole varie réellement.
  const positions = new Set();
  for (let i = 0; i < 200; i++) {
    const p = generatePassword(20, ['minuscules', 'symboles'], true);
    positions.add([...p].findIndex((c) => CHARSETS.symboles.includes(c)));
  }
  assert.ok(positions.size > 5, 'positions observées : ' + [...positions].join(', '));
});

test('refuse des paramètres incohérents', () => {
  assert.throws(() => generatePassword(2), RangeError);
  assert.throws(() => generatePassword(300), RangeError);
  assert.throws(() => generatePassword(20, []), Error);
  assert.throws(
    () => generatePassword(3, ['minuscules', 'majuscules', 'chiffres', 'symboles'], true),
    RangeError
  );
});

test('passwordBits calcule juste', () => {
  assert.equal(Math.round(passwordBits(20, 64)), 120);
});

console.log('\n' + ok + ' tests passés.');
