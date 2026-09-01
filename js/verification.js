// Banc d'essai de bout en bout, dans le vrai navigateur.
//
// Pourquoi il existe. Les tests Node couvrent la logique pure — fusion,
// rétention, emballage, générateur, file d'attente. Ils ne peuvent pas charger
// kdbxweb ni Argon2 dans les conditions réelles, et c'est précisément là que
// s'est caché le défaut du 2026-09-01 : deux sérialisations concurrentes du
// même coffre, qui produisent un fichier dont l'en-tête ne correspond plus au
// corps. Aucun test unitaire ne pouvait le voir.
//
// Ce que ce banc exerce, dans l'ordre où les données se perdent : sérialiser,
// relire, résister à la concurrence, fusionner, refuser ce qui est invalide.
//
// Il travaille sur un coffre jetable, en mémoire. Ni IndexedDB, ni réseau, ni
// contact avec le coffre de l'utilisateur.

import { createVault, openVault, saveVault, isWrongPassword, ressembleAKdbx, kdbxweb } from './vaultCrypto.js';
import { syncVault, createSyncState, CoffreDistantIllisible } from './mergeCycle.js';
import { creerFile } from './fileDAttente.js';
import { flattenGroups, allEntries, entriesOf, uuidsEnDouble, fieldText } from './vaultModel.js';

const $ = (id) => document.getElementById(id);
const PHRASE = 'banc essai coffre jetable mot passe';

const journal = [];
let reussis = 0;
let echoues = 0;

function noter(ligne) {
  journal.push(ligne);
  $('journal').textContent = journal.join('\n');
}

async function essai(nom, fn) {
  const t0 = performance.now();
  try {
    await fn();
    reussis += 1;
    noter(`  ok    ${nom}  (${Math.round(performance.now() - t0)} ms)`);
  } catch (err) {
    echoues += 1;
    noter(`  ECHEC ${nom}\n          ${(err && err.message) || String(err)}`);
  }
}

function section(titre) {
  noter(journal.length ? `\n${titre}` : titre);
}

function verifier(condition, message) {
  if (!condition) throw new Error(message);
}

/** Coffre jetable avec quelques entrées, pour ne pas mesurer sur du vide. */
function coffreDEssai(nbEntrees = 5) {
  const db = createVault(PHRASE, 'Coffre');
  const groupe = db.createGroup(db.getDefaultGroup(), 'Essai');
  for (let i = 0; i < nbEntrees; i += 1) {
    const e = db.createEntry(groupe);
    e.fields.set('Title', 'Entrée ' + i);
    e.fields.set('UserName', 'utilisateur' + i);
    e.fields.set('Password', kdbxweb.ProtectedValue.fromString('secret-' + i));
    e.times.update();
  }
  return db;
}

async function lancer() {
  journal.length = 0;
  reussis = 0;
  echoues = 0;
  $('journal').hidden = false;
  $('resume').hidden = false;
  $('resume').className = 'readout';
  $('resume').textContent = 'Vérification en cours…';
  $('lancer').disabled = true;

  const debut = performance.now();

  // -------------------------------------------------------------------------
  section('Écriture et relecture');

  await essai('un coffre créé se relit avec sa phrase', async () => {
    const db = coffreDEssai();
    const bytes = await saveVault(db);
    verifier(ressembleAKdbx(bytes), 'le tampon produit ne ressemble pas à un KDBX');
    const relu = await openVault(bytes, PHRASE);
    verifier(allEntries(relu).length === 5, 'entrées perdues à la relecture');
  });

  await essai('une phrase fausse est refusée franchement', async () => {
    const bytes = await saveVault(coffreDEssai(1));
    try {
      await openVault(bytes, PHRASE + ' faux');
      throw new Error('une phrase fausse a été acceptée');
    } catch (err) {
      verifier(isWrongPassword(err), 'erreur inattendue : ' + err.message);
    }
  });

  await essai('les mots de passe survivent à l’aller-retour', async () => {
    const db = coffreDEssai(3);
    const relu = await openVault(await saveVault(db), PHRASE);
    const attendus = allEntries(relu)
      .map(({ entry }) => fieldText(entry, 'Password'))
      .sort();
    verifier(attendus.join(',') === 'secret-0,secret-1,secret-2',
      'mots de passe altérés : ' + attendus.join(','));
  });

  // -------------------------------------------------------------------------
  section('Concurrence — le défaut du 2026-09-01');

  // Le témoin. Il ne juge pas : il mesure ce que coûte l'absence de file, et
  // rend visible la raison d'être de celle-ci. Mesuré le 2026-09-01 sur
  // Chromium : deux sérialisations simultanées font lever kdbxweb avec
  // « InvalidState: no xml ». Si une version future la rendait réentrante,
  // cette ligne le dirait — sans faire échouer le banc pour autant.
  await essai('témoin : ce que donne une sérialisation concurrente', async () => {
    const db = coffreDEssai(20);
    let relisibles = 0;
    let leve = null;

    try {
      const tampons = await Promise.all([saveVault(db), saveVault(db)]);
      for (const bytes of tampons) {
        try {
          await openVault(bytes, PHRASE);
          relisibles += 1;
        } catch { /* tampon abîmé : c'est le symptôme attendu */ }
      }
    } catch (err) {
      leve = (err && err.message) || String(err);
    }

    noter(leve
      ? `          sans file : kdbxweb lève « ${leve} » — la file est nécessaire`
      : `          sans file : ${relisibles}/2 tampons relisibles`);
  });

  await essai('avec la file, les deux sérialisations sont toujours relisibles', async () => {
    const db = coffreDEssai(20);
    const enfiler = creerFile();
    const [a, b] = await Promise.all([
      enfiler(() => saveVault(db)),
      enfiler(() => saveVault(db)),
    ]);
    for (const bytes of [a, b]) {
      verifier(ressembleAKdbx(bytes), 'tampon invalide malgré la file');
      await openVault(bytes, PHRASE);   // lève si corrompu
    }
  });

  await essai('dix enregistrements enchaînés restent tous relisibles', async () => {
    const db = coffreDEssai(10);
    const enfiler = creerFile();
    const travaux = [];
    for (let i = 0; i < 10; i += 1) {
      travaux.push(enfiler(async () => {
        const e = db.createEntry(db.getDefaultGroup());
        e.fields.set('Title', 'Ajout ' + i);
        e.times.update();
        return saveVault(db);
      }));
    }
    const tampons = await Promise.all(travaux);
    const dernier = await openVault(tampons[tampons.length - 1], PHRASE);
    verifier(allEntries(dernier).length === 20,
      'entrées manquantes : ' + allEntries(dernier).length + ' au lieu de 20');
  });

  // -------------------------------------------------------------------------
  section('Fusion');

  await essai('deux appareils convergent', async () => {
    const source = coffreDEssai(3);
    const bytes = await saveVault(source);

    const appareilA = await openVault(bytes, PHRASE);
    const appareilB = await openVault(bytes, PHRASE);

    const ea = appareilA.createEntry(appareilA.getDefaultGroup());
    ea.fields.set('Title', 'Ajoutée sur A');
    ea.times.update();

    const eb = appareilB.createEntry(appareilB.getDefaultGroup());
    eb.fields.set('Title', 'Ajoutée sur B');
    eb.times.update();

    appareilA.merge(appareilB);
    const titres = allEntries(appareilA).map(({ entry }) => fieldText(entry, 'Title'));
    verifier(titres.includes('Ajoutée sur A') && titres.includes('Ajoutée sur B'),
      'une modification a disparu à la fusion : ' + titres.join(', '));
  });

  await essai('un coffre distant illisible ne déclenche aucun envoi', async () => {
    let envois = 0;
    await new Promise((resolve) => {
      syncVault({
        db: coffreDEssai(1),
        state: createSyncState(),
        transport: {
          download: async () => new ArrayBuffer(300),
          upload: async () => { envois += 1; },
        },
        serialize: saveVault,
        deserialize: async () => { throw new Error('invalid gzip data'); },
      }).then(
        () => resolve(),
        (err) => {
          verifier(err instanceof CoffreDistantIllisible,
            'erreur non typée : ' + err.name);
          resolve();
        },
      );
    });
    verifier(envois === 0, 'un envoi a eu lieu malgré un coffre distant illisible');
  });

  await essai('un coffre sain n’a aucun identifiant en double', async () => {
    const db = coffreDEssai(8);
    const doubles = uuidsEnDouble(db);
    verifier(doubles.length === 0, 'doublons : ' + doubles.join(', '));
  });

  // -------------------------------------------------------------------------
  section('Refus des tampons invalides');

  await essai('un tampon vide, tronqué ou étranger est rejeté', async () => {
    verifier(!ressembleAKdbx(null), 'null accepté');
    verifier(!ressembleAKdbx(new ArrayBuffer(0)), 'tampon vide accepté');
    verifier(!ressembleAKdbx(new ArrayBuffer(64)), 'tampon trop court accepté');
    const faux = new ArrayBuffer(4096);
    new DataView(faux).setUint32(0, 0x12345678, true);
    verifier(!ressembleAKdbx(faux), 'signature étrangère acceptée');
  });

  await essai('un coffre réel est accepté', async () => {
    verifier(ressembleAKdbx(await saveVault(coffreDEssai(1))), 'coffre réel rejeté');
  });

  // -------------------------------------------------------------------------
  section('Lecture du contenu');

  await essai('la corbeille reste hors des comptes', async () => {
    const db = coffreDEssai(4);
    const victime = allEntries(db)[0].entry;
    db.remove(victime);
    verifier(allEntries(db).length === 3, '« Tout » compte la corbeille');
    verifier(entriesOf(db, db.getDefaultGroup()).length === 3,
      'la racine compte la corbeille');
  });

  await essai('les répertoires se comptent sans la corbeille', async () => {
    const db = coffreDEssai(2);
    db.remove(allEntries(db)[0].entry);
    const noms = flattenGroups(db).map((g) => g.name);
    verifier(!noms.some((n) => /recycle|corbeille/i.test(n)),
      'la corbeille apparaît dans la liste : ' + noms.join(', '));
  });

  // -------------------------------------------------------------------------
  section('Performance');

  await essai('une ouverture reste sous 3 secondes', async () => {
    const bytes = await saveVault(coffreDEssai(1));
    const t0 = performance.now();
    await openVault(bytes, PHRASE);
    const ms = Math.round(performance.now() - t0);
    noter(`          (dérivation Argon2 : ${ms} ms)`);
    verifier(ms < 3000, `ouverture trop lente : ${ms} ms`);
  });

  // -------------------------------------------------------------------------
  const duree = Math.round((performance.now() - debut) / 100) / 10;
  const el = $('resume');
  el.textContent = echoues === 0
    ? `${reussis} vérifications passées en ${duree} s. Rien à signaler.`
    : `${echoues} ÉCHEC${echoues > 1 ? 'S' : ''} sur ${reussis + echoues} — voir le détail ci-dessous.`;
  el.className = echoues === 0 ? 'readout' : 'readout readout-alert';
  $('lancer').disabled = false;
}

$('lancer').addEventListener('click', () => {
  lancer().catch((err) => {
    $('resume').hidden = false;
    $('resume').className = 'readout readout-alert';
    $('resume').textContent = 'Le banc lui-même a échoué : ' + ((err && err.message) || err);
    $('lancer').disabled = false;
  });
});
