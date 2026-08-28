// Tests du cycle de fusion (js/mergeCycle.js).
//
// Deux appareils, un faux Firebase Storage en mémoire, aucun réseau et aucun
// compte. Le kdbxweb utilisé est le vrai — celui de js/vendor/ — parce qu'un
// simulacre de fusion ne prouverait rien : ce qu'on veut vérifier, ce sont les
// règles de fusion de KDBX, pas celles qu'on aurait écrites soi-même.
//
// Ce fichier est la réponse directe à l'incident Firestore du 05/08/2026 sur
// Gestion Loc SCI : des écritures concurrentes s'y écrasaient au lieu de
// fusionner, et le défaut n'a été découvert qu'en production, sur des données
// réelles, faute de pouvoir rejouer le scénario hors ligne.
//
// DEUX PIÈGES découverts en écrivant ces tests, tous deux capables de faire
// croire à une panne de fusion qui n'existe pas :
//
//   1. Les horodatages KDBX ont une résolution d'UNE SECONDE. Un test qui
//      s'exécute d'un trait fait tout tomber dans la même seconde : les temps
//      sont à égalité, la fusion ne peut pas trancher et chaque appareil garde
//      sa version. On date donc tout explicitement (voir `à`), plutôt que
//      d'attendre vraiment — c'est déterministe et instantané.
//
//   2. kdbxweb ne met PAS à jour `lastModTime` quand on modifie un champ.
//      C'est à l'appelant d'appeler `entry.times.update()`. Sans cela, deux
//      appareils divergent en silence, définitivement. L'application le fait
//      (js/app.js), et les aides ci-dessous reproduisent ce même chemin.
//
// Lancer :  node tests/mergeLogic.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { createSyncState, syncVault } from '../js/mergeCycle.js';
import { argon2idAsync, argon2dAsync } from '../js/vendor/noble-hashes/argon2.js';

// --- Chargement de kdbxweb sous Node ---------------------------------------

// kdbxweb.min.js est un bundle UMD (CommonJS), alors que ce projet est déclaré
// "type": "module". Node parserait donc le fichier comme un module ES et
// planterait sur `module.exports`. On lui fournit explicitement l'enveloppe
// CommonJS qu'il attend. Le `require` transmis lui sert à charger 'crypto' et
// '@xmldom/xmldom' — cette dernière étant la seule dépendance npm du projet,
// réservée aux tests : dans un navigateur, kdbxweb utilise le DOMParser natif.
const require = createRequire(import.meta.url);
const kdbxweb = (() => {
  const source = readFileSync(new URL('../js/vendor/kdbxweb.min.js', import.meta.url), 'utf8');
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', source)(mod, mod.exports, require);
  return mod.exports;
})();

// --- Argon2 -----------------------------------------------------------------

// Même branchement que js/argon2Worker.js. `memory` arrive déjà en kibioctets :
// kdbxweb divise la valeur du fichier KDBX par 1024 en amont. Ne pas
// reconvertir — un facteur 1024 ici produirait un coffre illisible.
const TYPE_ARGON2ID = 2;

kdbxweb.CryptoEngine.setArgon2Impl(
  async (password, salt, memory, iterations, length, parallelism, type, version) => {
    const fn = type === TYPE_ARGON2ID ? argon2idAsync : argon2dAsync;
    const hash = await fn(new Uint8Array(password), new Uint8Array(salt), {
      t: iterations, m: memory, p: parallelism, dkLen: length, version,
    });
    return hash.buffer;
  }
);

// --- Ordonnanceur de tests --------------------------------------------------

let ok = 0;
const queue = [];
function test(nom, fn) { queue.push([nom, fn]); }
function section(titre) { queue.push([titre, null]); }

// --- Horloge de scénario ----------------------------------------------------

// Toutes les dates sont posées à la main, à des minutes d'écart, pour que
// l'ordre des événements soit lisible dans le test et jamais soumis à la
// vitesse de la machine. Le point de départ est l'instant réel, sans quoi les
// entrées créées par kdbxweb (datées « maintenant ») seraient postérieures aux
// modifications qu'on prétend leur appliquer.
const DÉPART = Date.now();
const à = (minutes) => new Date(DÉPART + minutes * 60_000);

// --- Outils -----------------------------------------------------------------

const PASSPHRASE = 'phrase.de.test.pour.la.fusion';

function credentials() {
  return new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(PASSPHRASE));
}

// Paramètres Argon2 volontairement minimaux. La robustesse du KDF n'a aucun
// effet sur les règles de fusion, et les vrais paramètres (64 Mio, 3 passes)
// rendraient ce fichier trop lent pour être lancé à chaque modification.
function applyFastKdf(db) {
  db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
  const p = db.header.kdfParameters;
  p.set('M', kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(1024 * 1024));
  p.set('I', kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(1));
  p.set('P', kdbxweb.VarDictionary.ValueType.UInt32, 1);
}

function createVault() {
  const db = kdbxweb.Kdbx.create(credentials(), 'Coffre de test');
  applyFastKdf(db);
  return db;
}

const serialize = (db) => db.save();
const deserialize = (bytes) => kdbxweb.Kdbx.load(bytes, credentials());

function addEntry(db, title, password = 'secret') {
  const entry = db.createEntry(db.getDefaultGroup());
  entry.fields.set('Title', title);
  entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(password));
  return entry;
}

function entryByTitle(db, title) {
  return db.getDefaultGroup().entries.find((e) => String(e.fields.get('Title')) === title);
}

/** Titres présents à la racine, triés. Une entrée supprimée n'y figure plus. */
function titles(db) {
  return db.getDefaultGroup().entries
    .map((e) => String(e.fields.get('Title')))
    .sort();
}

/** Contenu de la corbeille, trié. Une suppression KDBX est un déplacement. */
function binTitles(db) {
  const bin = db.meta.recycleBinUuid && db.getGroup(db.meta.recycleBinUuid);
  return bin ? bin.entries.map((e) => String(e.fields.get('Title'))).sort() : [];
}

function password(db, title) {
  const e = entryByTitle(db, title);
  // Attention : String() sur un champ protégé renvoie la forme chiffrée, qui
  // diffère à chaque appel. Seul getText() donne le contenu.
  return e ? e.fields.get('Password').getText() : null;
}

/** Modifie une entrée par le même chemin que l'application (js/app.js). */
function editEntry(db, title, nouveauMotDePasse, minutes) {
  const entry = entryByTitle(db, title);
  entry.pushHistory();
  entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(nouveauMotDePasse));
  entry.times.update();
  entry.times.lastModTime = à(minutes);
  return entry;
}

/** Supprime une entrée et date le déplacement, ce sur quoi la fusion tranche. */
function removeEntry(db, title, minutes) {
  const entry = entryByTitle(db, title);
  db.remove(entry);
  entry.times.locationChanged = à(minutes);
  return entry;
}

/** Faux Firebase Storage : un seul blob partagé, en mémoire. */
function createFakeStorage() {
  let blob = null;
  const log = { uploads: 0, downloads: 0 };
  return {
    log,
    // Chaque appareil reçoit son propre transport, mais tous pointent sur le
    // même blob — comme un unique objet users/{uid}/vault/db.kdbx.
    transport({ failUpload = false } = {}) {
      return {
        async download() {
          log.downloads++;
          return blob === null ? null : blob.slice(0);
        },
        async upload(bytes) {
          if (failUpload) throw new Error('panne réseau simulée');
          log.uploads++;
          blob = bytes.slice(0);
        },
      };
    },
  };
}

/** Un appareil : son coffre local, son état de synchronisation, son transport. */
async function createDevice(storage, bytes, { avecRéférence = true } = {}) {
  const device = {
    db: await deserialize(bytes),
    state: createSyncState(),
    transport: storage.transport(),
  };
  // L'appareil part d'un coffre déjà synchronisé : sa référence de fusion est
  // donc l'état courant, comme au sortir d'un cycle réussi.
  if (avecRéférence) device.state.lastEditState = device.db.getLocalEditState();
  return device;
}

function sync(device, storage, options) {
  return syncVault({
    db: device.db,
    state: device.state,
    transport: options ? storage.transport(options) : device.transport,
    serialize,
    deserialize,
  });
}

/** Publie un coffre de départ et renvoie ses octets, pour cloner deux appareils. */
async function publishOrigin(storage, build) {
  const db = createVault();
  build(db);
  await syncVault({ db, state: createSyncState(), transport: storage.transport(), serialize, deserialize });
  return serialize(db);
}

// --- Tests ------------------------------------------------------------------

section('Premier envoi');

test('un coffre distant absent est créé sans fusion', async () => {
  const storage = createFakeStorage();
  const db = createVault();
  addEntry(db, 'Banque');
  const state = createSyncState();

  const r = await syncVault({ db, state, transport: storage.transport(), serialize, deserialize });

  assert.equal(r.action, 'created');
  assert.equal(storage.log.uploads, 1);
  assert.ok(state.lastEditState, 'la référence de fusion doit être posée');
  const distant = await deserialize(await storage.transport().download());
  assert.deepEqual(titles(distant), ['Banque']);

  // Les octets rendus doivent être exactement ceux envoyés : l'appelant les
  // enregistre localement au lieu de re-sérialiser, ce qui économise une
  // dérivation Argon2 complète.
  assert.ok(r.bytes instanceof ArrayBuffer, 'le cycle doit rendre les octets envoyés');
  assert.deepEqual(titles(await deserialize(r.bytes)), ['Banque']);
});

section('Création concurrente');

test('deux entrées créées en parallèle survivent toutes les deux', async () => {
  const storage = createFakeStorage();
  const base = await publishOrigin(storage, (db) => addEntry(db, 'Commune'));

  const a = await createDevice(storage, base);
  const b = await createDevice(storage, base);

  addEntry(a.db, 'Depuis A');
  addEntry(b.db, 'Depuis B');

  await sync(a, storage);
  await sync(b, storage);

  assert.deepEqual(titles(b.db), ['Commune', 'Depuis A', 'Depuis B']);

  // A ne connaît pas encore l'entrée de B : il lui faut un second cycle.
  await sync(a, storage);
  assert.deepEqual(titles(a.db), ['Commune', 'Depuis A', 'Depuis B']);
});

section('Modification concurrente de la même entrée');

test('la modification la plus récente gagne, sans duplication', async () => {
  const storage = createFakeStorage();
  const base = await publishOrigin(storage, (db) => addEntry(db, 'Messagerie', 'origine'));

  const a = await createDevice(storage, base);
  const b = await createDevice(storage, base);

  editEntry(a.db, 'Messagerie', 'choix-de-A', 10);
  editEntry(b.db, 'Messagerie', 'choix-de-B', 20);   // plus récent

  await sync(a, storage);
  await sync(b, storage);
  await sync(a, storage);

  assert.equal(password(a.db, 'Messagerie'), 'choix-de-B');
  assert.equal(password(b.db, 'Messagerie'), 'choix-de-B');
  assert.equal(titles(a.db).length, 1, 'aucune entrée dupliquée');
});

test("la version écartée reste consultable dans l'historique", async () => {
  const storage = createFakeStorage();
  const base = await publishOrigin(storage, (db) => addEntry(db, 'Messagerie', 'origine'));

  const a = await createDevice(storage, base);
  const b = await createDevice(storage, base);

  editEntry(a.db, 'Messagerie', 'choix-de-A', 10);
  editEntry(b.db, 'Messagerie', 'choix-de-B', 20);

  await sync(a, storage);
  await sync(b, storage);

  const passés = entryByTitle(b.db, 'Messagerie').history
    .map((h) => h.fields.get('Password').getText());

  assert.ok(
    passés.includes('choix-de-A'),
    `la valeur écartée doit rester récupérable, historique = ${JSON.stringify(passés)}`
  );
});

section('Suppression');

test('une suppression se propage à l\'autre appareil', async () => {
  const storage = createFakeStorage();
  const base = await publishOrigin(storage, (db) => {
    addEntry(db, 'Garder');
    addEntry(db, 'Supprimer');
  });

  const a = await createDevice(storage, base);
  const b = await createDevice(storage, base);

  removeEntry(a.db, 'Supprimer', 10);
  await sync(a, storage);
  await sync(b, storage);

  assert.deepEqual(titles(b.db), ['Garder']);
  assert.deepEqual(binTitles(b.db), ['Supprimer'], 'une suppression KDBX est un déplacement en corbeille, pas un effacement');
});

test('une suppression ne ressuscite pas au cycle suivant', async () => {
  const storage = createFakeStorage();
  const base = await publishOrigin(storage, (db) => {
    addEntry(db, 'Garder');
    addEntry(db, 'Supprimer');
  });

  const a = await createDevice(storage, base);
  const b = await createDevice(storage, base);

  removeEntry(a.db, 'Supprimer', 10);
  addEntry(b.db, 'Ajout de B');   // B travaille en même temps

  await sync(a, storage);
  await sync(b, storage);
  await sync(a, storage);
  await sync(b, storage);

  assert.deepEqual(titles(a.db), ['Ajout de B', 'Garder']);
  assert.deepEqual(titles(b.db), ['Ajout de B', 'Garder']);
});

test("supprimée d'un côté, modifiée de l'autre : les deux appareils tranchent pareil", async () => {
  const storage = createFakeStorage();
  const base = await publishOrigin(storage, (db) => {
    addEntry(db, 'Garder');
    addEntry(db, 'Disputée', 'origine');
  });

  const a = await createDevice(storage, base);
  const b = await createDevice(storage, base);

  removeEntry(a.db, 'Disputée', 10);
  editEntry(b.db, 'Disputée', 'modifiée-par-B', 20);   // postérieur à la suppression

  await sync(a, storage);
  await sync(b, storage);
  await sync(a, storage);
  await sync(b, storage);

  // Ce qui compte n'est pas le vainqueur mais l'accord : un désaccord durable
  // serait la vraie panne, et c'est exactement la forme de l'incident d'août.
  assert.deepEqual(
    titles(a.db), titles(b.db),
    'les deux appareils doivent aboutir au même contenu'
  );
  assert.deepEqual(
    binTitles(a.db), binTitles(b.db),
    'et à la même corbeille'
  );
});

section('Robustesse du cycle');

test('un envoi en échec ne consomme pas la référence de fusion', async () => {
  const storage = createFakeStorage();
  const base = await publishOrigin(storage, (db) => addEntry(db, 'Commune'));

  const a = await createDevice(storage, base);
  const référenceAvant = a.state.lastEditState;

  addEntry(a.db, 'Ajout local');

  await assert.rejects(
    () => sync(a, storage, { failUpload: true }),
    /panne réseau simulée/
  );

  assert.equal(
    a.state.lastEditState, référenceAvant,
    "une synchro échouée ne doit pas déplacer la référence, sinon le cycle suivant croirait à tort que l'ajout est déjà connu du distant"
  );

  // Le cycle suivant, réseau rétabli, doit rattraper l'envoi.
  await sync(a, storage);
  const distant = await deserialize(await storage.transport().download());
  assert.deepEqual(titles(distant), ['Ajout local', 'Commune']);
});

test('deux appareils convergent après un aller-retour complet', async () => {
  const storage = createFakeStorage();
  const base = await publishOrigin(storage, (db) => addEntry(db, 'Commune'));

  const a = await createDevice(storage, base);
  const b = await createDevice(storage, base);

  addEntry(a.db, 'A1');
  addEntry(b.db, 'B1');
  removeEntry(a.db, 'Commune', 10);

  await sync(a, storage);
  await sync(b, storage);
  await sync(a, storage);
  await sync(b, storage);

  assert.deepEqual(titles(a.db), titles(b.db), 'les deux appareils doivent voir la même chose');
  assert.deepEqual(titles(a.db), ['A1', 'B1']);
});

section('Ce que setLocalEditState change réellement');

// Constat, et non souhait : sur tous les scénarios ci-dessus, retirer la
// référence de fusion ne modifie rien au résultat. Les suppressions sont
// inscrites dans le fichier lui-même (déplacement en corbeille, daté), et les
// modifications sont arbitrées par lastModTime : la fusion n'a pas besoin de
// savoir ce qui avait changé « depuis la dernière fois ».
//
// L'appel est conservé dans js/mergeCycle.js parce que c'est la marche à
// suivre publiée par kdbxweb, qu'il est sans coût, et qu'il pourrait compter
// dans des cas non couverts ici. Ce test fige le constat : s'il se met à
// échouer après une montée de version de kdbxweb, c'est que le comportement a
// changé et qu'il faut réexaminer le cycle — pas le supprimer.
test('retirer la référence ne change rien aux scénarios couverts', async () => {
  const scénario = async (avecRéférence) => {
    const storage = createFakeStorage();
    const base = await publishOrigin(storage, (db) => {
      addEntry(db, 'Garder');
      addEntry(db, 'Disputée', 'origine');
    });
    const a = await createDevice(storage, base, { avecRéférence });
    const b = await createDevice(storage, base, { avecRéférence });

    removeEntry(a.db, 'Disputée', 10);
    addEntry(b.db, 'B1');
    editEntry(b.db, 'Garder', 'modifiée-par-B', 20);

    await sync(a, storage);
    await sync(b, storage);
    await sync(a, storage);
    await sync(b, storage);

    return JSON.stringify({
      a: titles(a.db), corbeilleA: binTitles(a.db), mdpA: password(a.db, 'Garder'),
      b: titles(b.db), corbeilleB: binTitles(b.db), mdpB: password(b.db, 'Garder'),
    });
  };

  assert.equal(await scénario(true), await scénario(false));
});

// --- Exécution --------------------------------------------------------------

const t0 = Date.now();
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
console.log(`\n${ok} tests passés en ${Date.now() - t0} ms.`);
