// Tests de la politique de rétention des copies (js/backupPolicy.js).
//
// Ce code décide quelles sauvegardes supprimer. Une erreur ici ne se voit pas :
// elle se découvre le jour où l'on cherche une copie qui n'existe plus. D'où
// des tests sur la logique pure, avec un « maintenant » fixé.
//
// Lancer :  node tests/backupPolicy.test.mjs

import assert from 'node:assert/strict';
import {
  trierCopies, nomDeCopie, dateDeCopie, POLITIQUE_PAR_DEFAUT,
} from '../js/backupPolicy.js';

let ok = 0;
const queue = [];
const test = (nom, fn) => queue.push([nom, fn]);
const section = (titre) => queue.push([titre, null]);

const MAINTENANT = new Date('2026-08-28T12:00:00.000Z');
const JOUR = 86400000;

/**
 * Copie située à `joursAvant` jours et `heuresAvant` heures de MAINTENANT.
 *
 * MAINTENANT est à 12:00 UTC : garder `heuresAvant` sous 12 évite de basculer
 * sur la veille sans le vouloir, ce qui fausserait les comptages par jour.
 */
function copie(joursAvant, heuresAvant = 0) {
  const d = new Date(MAINTENANT.getTime() - joursAvant * JOUR - heuresAvant * 3600000);
  return { nom: nomDeCopie(d), date: d };
}

/** Copie de la même journée, à quelques minutes d'écart. */
function copieMinutes(minutesAvant) {
  const d = new Date(MAINTENANT.getTime() - minutesAvant * 60000);
  return { nom: nomDeCopie(d), date: d };
}

const compte = (r) => ({ garder: r.garder.length, supprimer: r.supprimer.length });

// --- Noms de fichiers -------------------------------------------------------

section('Nommage des copies');

test('un nom se relit en la date qui l’a produit', () => {
  const d = new Date('2026-08-28T09:15:30.123Z');
  assert.equal(nomDeCopie(d), '2026-08-28T09-15-30-123Z.kdbx');
  assert.equal(dateDeCopie(nomDeCopie(d)).getTime(), d.getTime());
});

test('le tri alphabétique des noms suit le tri chronologique', () => {
  const dates = [
    new Date('2026-01-05T23-00-00.000Z'.replace(/-(\d\d)-(\d\d)\./, ':$1:$2.')),
    new Date('2026-01-06T01:00:00.000Z'),
    new Date('2025-12-31T23:59:59.000Z'),
  ];
  const noms = dates.map(nomDeCopie);
  const parNom = [...noms].sort();
  const parDate = [...dates].sort((a, b) => a - b).map(nomDeCopie);
  assert.deepEqual(parNom, parDate);
});

test('un fichier au nom étranger n’est pas interprété', () => {
  // Garde-fou : un fichier déposé à la main ne doit jamais être pris pour une
  // copie automatique, sous peine d'être supprimé par la rotation.
  assert.equal(dateDeCopie('db.kdbx'), null);
  assert.equal(dateDeCopie('sauvegarde-manuelle.kdbx'), null);
  assert.equal(dateDeCopie('2026-13-45T99-99-99-999Z.kdbx'), null);
});

// --- Rétention --------------------------------------------------------------

section('Rétention');

test('en dessous du seuil, rien n’est supprimé', () => {
  const copies = [copie(0), copie(0, 1), copie(0, 2)];
  const r = trierCopies(copies, MAINTENANT);
  assert.deepEqual(compte(r), { garder: 3, supprimer: 0 });
});

test('les copies rapprochées du jour même sont toutes gardées jusqu’à N', () => {
  // Cas réel : plusieurs enregistrements dans la même heure. C'est précisément
  // là qu'une mauvaise fusion se rattrape, il ne faut pas les écraser.
  const copies = Array.from({ length: 15 }, (_, i) => copieMinutes(i));
  const r = trierCopies(copies, MAINTENANT);
  assert.equal(r.garder.length, POLITIQUE_PAR_DEFAUT.recentes);
  assert.equal(r.supprimer.length, 5);
  // Ce sont bien les plus anciennes qui partent.
  assert.equal(r.garder[0], copies[0].nom, 'la plus récente doit être gardée');
  assert.ok(r.supprimer.includes(copies[14].nom), 'la plus ancienne doit partir');
});

test('une copie par jour survit sur la fenêtre de 30 jours', () => {
  // Trois copies par jour pendant 20 jours : on attend les 10 plus récentes,
  // plus une par jour pour les jours antérieurs.
  const copies = [];
  for (let j = 0; j < 20; j += 1) {
    for (const h of [1, 5, 9]) copies.push(copie(j, h));
  }
  const r = trierCopies(copies, MAINTENANT);

  const jours = new Set(r.garder.map((n) => n.slice(0, 10)));
  assert.equal(jours.size, 20, 'chacun des 20 jours doit rester représenté');
  assert.ok(r.supprimer.length > 0, 'les doublons intra-journaliers doivent partir');
});

test('au-delà de 30 jours, seule une copie par mois subsiste', () => {
  // Une copie par jour sur 200 jours.
  const copies = Array.from({ length: 200 }, (_, j) => copie(j, 3));
  const r = trierCopies(copies, MAINTENANT);

  const anciennes = r.garder.filter((n) => {
    const d = dateDeCopie(n);
    return d.getTime() < MAINTENANT.getTime() - 30 * JOUR;
  });
  const moisGardes = new Set(anciennes.map((n) => n.slice(0, 7)));
  assert.equal(moisGardes.size, anciennes.length,
    'au-delà de 30 jours, pas plus d’une copie par mois');
  assert.ok(anciennes.length >= 4 && anciennes.length <= 7,
    `200 jours couvrent 6 à 7 mois, ${anciennes.length} conservée(s)`);
});

test('rien n’est gardé au-delà de la fenêtre mensuelle', () => {
  // Il faut saturer les N plus récentes, sinon la copie ancienne y entre et
  // survit — ce qui est le comportement voulu quand on a peu de copies, et que
  // le test suivant vérifie explicitement.
  const recentes = Array.from({ length: 12 }, (_, i) => copieMinutes(i));
  const tresVieille = copie(400);
  const r = trierCopies([...recentes, tresVieille], MAINTENANT);
  assert.ok(r.supprimer.includes(tresVieille.nom),
    'une copie de plus de 12 mois doit être supprimée');
});

test('avec peu de copies, même une très ancienne est conservée', () => {
  // Propriété de sûreté délibérée : on ne supprime jamais tant qu'on n'a pas
  // atteint le nombre de copies récentes voulu, quel que soit leur âge.
  const tresVieille = copie(400);
  const r = trierCopies([copie(0), tresVieille], MAINTENANT);
  assert.deepEqual(r.supprimer, [],
    'deux copies seulement : rien ne doit être supprimé');
});

section('Garanties');

test('aucune copie n’est à la fois gardée et supprimée', () => {
  const copies = Array.from({ length: 300 }, (_, j) => copie(j % 150, j % 24));
  const r = trierCopies(copies, MAINTENANT);
  const croisement = r.garder.filter((n) => r.supprimer.includes(n));
  assert.deepEqual(croisement, [], 'les deux listes doivent être disjointes');
});

test('la plus récente n’est jamais supprimée', () => {
  // Invariant le plus important du module : quoi qu'il arrive, le dernier état
  // connu doit rester récupérable.
  for (const n of [1, 5, 50, 500]) {
    const copies = Array.from({ length: n }, (_, j) => copie(j, j % 24));
    const r = trierCopies(copies, MAINTENANT);
    const plusRecente = [...copies].sort((a, b) => b.date - a.date)[0].nom;
    assert.ok(r.garder.includes(plusRecente), `n=${n} : la plus récente doit survivre`);
    assert.ok(!r.supprimer.includes(plusRecente), `n=${n} : et ne pas être supprimée`);
  }
});

test('une liste vide ne fait rien planter', () => {
  assert.deepEqual(trierCopies([], MAINTENANT), { garder: [], supprimer: [] });
});

// --- Exécution --------------------------------------------------------------

for (const [nom, fn] of queue) {
  if (fn === null) { console.log('\n' + nom); continue; }
  try {
    fn();
    ok++;
    console.log('  ok   ' + nom);
  } catch (e) {
    console.error('  ECHEC ' + nom + '\n        ' + e.message);
    process.exitCode = 1;
  }
}
console.log(`\n${ok} tests passés.`);
