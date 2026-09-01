// Tests du modèle de lecture du coffre (js/vaultModel.js).
//
// Aucun navigateur, aucun kdbxweb, aucun fichier .kdbx : les groupes et les
// entrées sont de faux objets qui respectent la même forme. C'est possible
// parce que vaultModel.js ne dépend d'aucune classe concrète — il reconnaît un
// champ protégé à sa méthode getText(), pas à son type.
//
// Lancer :  node tests/vaultModel.test.mjs

import assert from 'node:assert/strict';
import {
  fieldText, groupName, flattenGroups, entriesOf, allEntries,
  sortByTitle, searchEntries, normalize, customFields, urlHost, uuidsEnDouble,
} from '../js/vaultModel.js';

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

// --- Fabriques de faux objets ----------------------------------------------

let uuidSeq = 0;
const protectedValue = (txt) => ({ getText: () => txt });

function entry(fields) {
  return { fields: new Map(Object.entries(fields)) };
}

function group(name, { entries = [], groups = [] } = {}) {
  return { name, uuid: 'uuid-' + (++uuidSeq), entries, groups };
}

function database(roots, recycleBinUuid = null) {
  return { groups: roots, meta: { recycleBinUuid } };
}

// ---------------------------------------------------------------------------

console.log('\nLecture des champs');

test('champ absent renvoie une chaîne vide', () => {
  assert.equal(fieldText(entry({}), 'Title'), '');
});

test('champ texte simple', () => {
  assert.equal(fieldText(entry({ Title: 'Amazon' }), 'Title'), 'Amazon');
});

test('champ protégé passe par getText()', () => {
  const e = entry({ Password: protectedValue('S3cret!') });
  assert.equal(fieldText(e, 'Password'), 'S3cret!');
});

test('nom de groupe absent ne renvoie jamais "undefined"', () => {
  assert.equal(groupName({ name: undefined }), 'Sans nom');
  assert.equal(groupName({ name: '' }), 'Sans nom');
  assert.equal(groupName({ name: 'Banques' }), 'Banques');
});

console.log('\nArborescence des groupes');

const banque = group('Banques', { entries: [entry({ Title: 'Zenith' })] });
const perso = group('Perso', {
  entries: [entry({ Title: 'Amazon' })],
  groups: [group('Abonnements', { entries: [entry({ Title: 'Netflix' })] })],
});
const corbeille = group('Corbeille', { entries: [entry({ Title: 'Vieux compte' })] });
const racine = group('Coffre', { groups: [banque, perso, corbeille] });
const db = database([racine], corbeille.uuid);

test('parcours en profondeur, avec la bonne profondeur', () => {
  const plat = flattenGroups(db);
  assert.deepEqual(
    plat.map((g) => g.name + '@' + g.depth),
    ['Coffre@0', 'Banques@1', 'Perso@1', 'Abonnements@2']
  );
});

test('la corbeille est exclue par défaut', () => {
  assert.ok(!flattenGroups(db).some((g) => g.name === 'Corbeille'));
});

test('la corbeille est incluse et marquée si on la demande', () => {
  const plat = flattenGroups(db, { includeRecycleBin: true });
  const c = plat.find((g) => g.name === 'Corbeille');
  assert.ok(c, 'corbeille absente');
  assert.equal(c.isRecycleBin, true);
});

test('un coffre sans corbeille définie ne plante pas', () => {
  // Sans recycleBinUuid, « Corbeille » n'est qu'un groupe ordinaire : les 5
  // groupes remontent, y compris lui. C'est le comportement voulu — rien ne
  // doit être masqué sur la foi d'un nom.
  const sansMeta = { groups: [racine] };
  assert.equal(flattenGroups(sansMeta).length, 5);
  assert.ok(flattenGroups(sansMeta).every((g) => g.isRecycleBin === false));
});

test('le compte d\'entrées est celui du groupe seul', () => {
  const plat = flattenGroups(db);
  assert.equal(plat.find((g) => g.name === 'Perso').entryCount, 1);
});

console.log('\nListes d\'entrées');

test('entriesOf descend dans les sous-groupes par défaut', () => {
  const titres = entriesOf(db, perso).map(({ entry: e }) => fieldText(e, 'Title'));
  assert.deepEqual(titres.sort(), ['Amazon', 'Netflix']);
});

test('entriesOf peut rester au niveau du groupe', () => {
  const titres = entriesOf(db, perso, false).map(({ entry: e }) => fieldText(e, 'Title'));
  assert.deepEqual(titres, ['Amazon']);
});

test('entriesOf ignore la corbeille en descendant', () => {
  const titres = entriesOf(db, racine).map(({ entry: e }) => fieldText(e, 'Title'));
  assert.ok(!titres.includes('Vieux compte'),
    'entrée de corbeille comptée dans la racine : ' + titres.join(', '));
  assert.deepEqual(titres.sort(), ['Amazon', 'Netflix', 'Zenith']);
});

test('entriesOf sans coffre connu descend partout, corbeille comprise', () => {
  const titres = entriesOf(null, racine).map(({ entry: e }) => fieldText(e, 'Title'));
  assert.ok(titres.includes('Vieux compte'));
});

test('allEntries ignore la corbeille', () => {
  const titres = allEntries(db).map(({ entry: e }) => fieldText(e, 'Title'));
  assert.ok(!titres.includes('Vieux compte'), 'entrée de corbeille remontée : ' + titres.join(', '));
  assert.deepEqual(titres.sort(), ['Amazon', 'Netflix', 'Zenith']);
});

test('allEntries rattache chaque entrée à son groupe', () => {
  const netflix = allEntries(db).find(({ entry: e }) => fieldText(e, 'Title') === 'Netflix');
  assert.equal(netflix.group.name, 'Abonnements');
});

console.log('\nTri');

test('un coffre sain n’a aucun doublon d’identifiant', () => {
  assert.deepEqual(uuidsEnDouble(db), []);
});

// kdbxweb refuse de fusionner un coffre où un identifiant désigne deux
// objets — « MergeError: duplicate » — et la synchronisation s'arrête net.
test('une entrée atteignable depuis deux groupes est signalée', () => {
  const partagee = entry({ Title: 'Doublon' });
  partagee.uuid = 'uuid-partage';
  const a1 = group('A', { entries: [partagee] });
  const b1 = group('B', { entries: [partagee] });
  const r = group('Coffre', { groups: [a1, b1] });
  assert.deepEqual(uuidsEnDouble(database([r])), ['uuid-partage']);
});

test('les accents sont classés comme la lettre de base', () => {
  const rows = [
    { entry: entry({ Title: 'Zenith' }), group: racine },
    { entry: entry({ Title: 'Électricité' }), group: racine },
    { entry: entry({ Title: 'Amazon' }), group: racine },
  ];
  assert.deepEqual(
    sortByTitle(rows).map(({ entry: e }) => fieldText(e, 'Title')),
    ['Amazon', 'Électricité', 'Zenith']
  );
});

test('le tri ignore la casse', () => {
  const rows = ['banque', 'Amazon', 'Zenith'].map((t) => ({ entry: entry({ Title: t }), group: racine }));
  assert.deepEqual(
    sortByTitle(rows).map(({ entry: e }) => fieldText(e, 'Title')),
    ['Amazon', 'banque', 'Zenith']
  );
});

test('sortByTitle ne modifie pas le tableau reçu', () => {
  const rows = [
    { entry: entry({ Title: 'Zenith' }), group: racine },
    { entry: entry({ Title: 'Amazon' }), group: racine },
  ];
  const avant = rows.map(({ entry: e }) => fieldText(e, 'Title'));
  sortByTitle(rows);
  assert.deepEqual(rows.map(({ entry: e }) => fieldText(e, 'Title')), avant);
});

console.log('\nRecherche');

test('normalize retire accents et casse', () => {
  assert.equal(normalize('Électricité'), 'electricite');
  assert.equal(normalize('Crédit Agricole'), 'credit agricole');
});

const rows = allEntries(db);

test('recherche sans accents trouve un titre accentué', () => {
  const avecAccent = [{ entry: entry({ Title: 'Électricité' }), group: racine }];
  assert.equal(searchEntries(avecAccent, 'electricite').length, 1);
  assert.equal(searchEntries(avecAccent, 'ÉLECTRICITÉ').length, 1);
});

test('recherche vide renvoie tout', () => {
  assert.equal(searchEntries(rows, '').length, rows.length);
  assert.equal(searchEntries(rows, '   ').length, rows.length);
});

test('recherche par nom de groupe', () => {
  assert.deepEqual(
    searchEntries(rows, 'abonnements').map(({ entry: e }) => fieldText(e, 'Title')),
    ['Netflix']
  );
});

test('la recherche ne parcourt PAS les mots de passe', () => {
  // Sinon le champ de recherche deviendrait un oracle : taper des fragments
  // révélerait le contenu d'un mot de passe sans jamais l'afficher.
  const secret = [{
    entry: entry({ Title: 'Banque', Password: protectedValue('licorne-bleue') }),
    group: racine,
  }];
  assert.equal(searchEntries(secret, 'licorne').length, 0);
  assert.equal(searchEntries(secret, 'banque').length, 1);
});

test('la recherche ne parcourt PAS les notes', () => {
  const notes = [{
    entry: entry({ Title: 'Banque', Notes: 'code guichet 4412' }),
    group: racine,
  }];
  assert.equal(searchEntries(notes, '4412').length, 0);
});

console.log('\nChamps personnalisés et URL');

test('les champs hors standard sont remontés', () => {
  const e = entry({ Title: 'Banque', 'Numéro client': '881204', Password: protectedValue('x') });
  assert.deepEqual(customFields(e), [{ key: 'Numéro client', value: '881204' }]);
});

test('un champ personnalisé protégé est lisible', () => {
  const e = entry({ Title: 'B', 'Code secret': protectedValue('4412') });
  assert.deepEqual(customFields(e), [{ key: 'Code secret', value: '4412' }]);
});

test('urlHost extrait le domaine, avec ou sans schéma', () => {
  assert.equal(urlHost('https://www.amazon.fr/compte'), 'www.amazon.fr');
  assert.equal(urlHost('amazon.fr'), 'amazon.fr');
});

test('urlHost renvoie une chaîne vide sur une URL inexploitable', () => {
  assert.equal(urlHost(''), '');
  assert.equal(urlHost('   '), '');
  assert.equal(urlHost('http://'), '');
});

console.log('\n' + ok + ' tests passés.');
