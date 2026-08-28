// Diagnostic du déverrouillage biométrique (phase 5).
//
// Ce que la page valide, dans l'ordre où ça peut casser :
//   1. contexte sécurisé (WebAuthn n'existe pas en http:// hors localhost)
//   2. présence d'un authentificateur de plateforme (Face ID, empreinte, Hello)
//   3. support de l'extension PRF à la création de la clé
//   4. obtention d'une sortie PRF à l'authentification
//   5. DÉTERMINISME : même sel, même sortie
//
// Le point 5 est le seul qui compte vraiment. Le schéma de déverrouillage
// repose entièrement dessus : la sortie PRF sert à emballer la clé maître, donc
// si elle change d'une fois sur l'autre, la clé devient irrécupérable. Un
// appareil qui passe 1 à 4 mais échoue en 5 est inutilisable pour ce montage.

import {
  createVault, saveVault, openVault, argon2Backend, DEFAULT_KDF, kdbxweb,
} from './vaultCrypto.js';

const $ = (id) => document.getElementById(id);
const results = $('results');

function line(etat, titre, detail) {
  const li = document.createElement('li');
  li.className = 'diag-line diag-' + etat;
  const t = document.createElement('span');
  t.className = 'diag-line-title';
  t.textContent = ({ ok: '✓ ', ko: '✗ ', info: '• ' }[etat] || '') + titre;
  li.append(t);
  if (detail) {
    const d = document.createElement('span');
    d.className = 'diag-line-detail';
    d.textContent = detail;
    li.append(d);
  }
  results.append(li);
  return li;
}

function verdict(ok, texte) {
  const v = $('verdict');
  v.hidden = false;
  v.className = 'diag-verdict ' + (ok ? 'diag-verdict-ok' : 'diag-verdict-ko');
  v.textContent = texte;
}

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// --- Contexte, affiché avant même de lancer le test -------------------------

(function showContext() {
  const box = $('context');
  const rows = [
    ['Adresse', location.origin],
    ['Contexte sécurisé', window.isSecureContext ? 'oui' : 'NON'],
    ['Domaine WebAuthn (rpId)', location.hostname],
    ['Navigateur', navigator.userAgent],
  ];
  for (const [k, v] of rows) {
    const p = document.createElement('p');
    p.className = 'diag-ctx';
    const b = document.createElement('strong');
    b.textContent = k + ' : ';
    p.append(b, document.createTextNode(v));
    box.append(p);
  }

  if (!window.isSecureContext) {
    const warn = document.createElement('p');
    warn.className = 'error';
    warn.textContent =
      "WebAuthn exige un contexte sécurisé. En http:// sur une adresse réseau "
      + "(192.168.x.x), le test échouera quel que soit l'appareil. Testez le "
      + "téléphone sur l'adresse HTTPS déployée, pas sur le serveur local.";
    box.append(warn);
  }
})();

// --- Test -------------------------------------------------------------------

async function run() {
  results.textContent = '';
  $('verdict').hidden = true;
  $('btn-run').disabled = true;

  try {
    // 1. Contexte sécurisé
    if (!window.isSecureContext) {
      line('ko', 'Contexte non sécurisé', 'WebAuthn est indisponible en http:// hors localhost.');
      verdict(false, "Test impossible ici. Rejouez-le sur l'adresse HTTPS déployée.");
      return;
    }
    line('ok', 'Contexte sécurisé');

    // 2. API présente
    if (!window.PublicKeyCredential) {
      line('ko', 'WebAuthn absent', "Ce navigateur n'expose pas PublicKeyCredential.");
      verdict(false, 'Cet appareil ne peut pas servir au déverrouillage biométrique.');
      return;
    }
    line('ok', 'WebAuthn disponible');

    // 3. Authentificateur de plateforme
    const plateforme = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!plateforme) {
      line('ko', 'Aucun authentificateur de plateforme',
        "Pas de Face ID, d'empreinte ni de Windows Hello utilisable.");
      verdict(false, 'Cet appareil ne peut pas servir au déverrouillage biométrique.');
      return;
    }
    line('ok', 'Authentificateur de plateforme disponible');

    // 4. Création d'une clé avec l'extension PRF
    const userId = crypto.getRandomValues(new Uint8Array(16));
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'Coffre — diagnostic', id: location.hostname },
        user: { id: userId, name: 'diagnostic', displayName: 'Diagnostic' },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },    // ES256
          { type: 'public-key', alg: -257 },  // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'preferred',
          userVerification: 'required',
        },
        timeout: 120000,
        extensions: { prf: {} },
      },
    });

    const ext = cred.getClientExtensionResults();
    // `enabled` peut être absent alors que PRF fonctionne quand même à
    // l'authentification : on le signale sans conclure tout de suite.
    if (ext.prf && ext.prf.enabled) {
      line('ok', 'Extension PRF annoncée à la création');
    } else {
      line('info', 'PRF non annoncée à la création',
        "Certains navigateurs ne renseignent ce drapeau qu'à l'authentification. On continue.");
    }

    // 5. Deux authentifications avec le MÊME sel
    const sel = new TextEncoder().encode('coffre-diagnostic-sel-fixe');
    const lire = async () => {
      const a = await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rpId: location.hostname,
          allowCredentials: [{ type: 'public-key', id: cred.rawId }],
          userVerification: 'required',
          timeout: 120000,
          extensions: { prf: { eval: { first: sel } } },
        },
      });
      const r = a.getClientExtensionResults();
      return r.prf && r.prf.results ? r.prf.results.first : null;
    };

    const un = await lire();
    if (!un) {
      line('ko', 'Aucune sortie PRF',
        "L'authentification a réussi mais l'appareil n'a renvoyé aucune valeur PRF.");
      verdict(false,
        'PRF indisponible ici. Le déverrouillage biométrique ne peut pas être construit '
        + 'sur cet appareil — il faudrait rester au mot de passe maître.');
      return;
    }
    line('ok', 'Sortie PRF obtenue', new Uint8Array(un).length + ' octets');

    if (new Uint8Array(un).length < 32) {
      line('ko', 'Sortie PRF trop courte', 'Au moins 32 octets sont attendus.');
      verdict(false, 'Sortie PRF inexploitable pour dériver une clé.');
      return;
    }

    const deux = await lire();
    const identiques = deux && toHex(un) === toHex(deux);
    if (!identiques) {
      line('ko', 'Sortie PRF NON déterministe',
        'Deux appels avec le même sel donnent des valeurs différentes.');
      verdict(false,
        "Rédhibitoire : la clé maître emballée avec cette valeur serait "
        + "irrécupérable au déverrouillage suivant. Le déverrouillage biométrique "
        + "n'est pas utilisable sur cet appareil.");
      return;
    }
    line('ok', 'Sortie PRF déterministe', 'Deux appels, même sel, même résultat.');
    line('info', 'Empreinte de la valeur', toHex(un).slice(0, 16) + '…');

    verdict(true,
      'Cet appareil convient au déverrouillage biométrique. '
      + "Vous pouvez supprimer la clé « Coffre — diagnostic » dans les réglages "
      + 'du système ou du navigateur.');
  } catch (err) {
    const nom = err && err.name ? err.name : 'Erreur';
    const msg = err && err.message ? err.message : String(err);
    if (nom === 'NotAllowedError') {
      line('ko', 'Test interrompu', 'Demande refusée ou expirée.');
      verdict(false, "Test non concluant : la demande a été refusée. Relancez et validez l'invite.");
    } else {
      line('ko', nom, msg);
      verdict(false, 'Test en échec : ' + nom + '. Voir le détail ci-dessus.');
    }
  } finally {
    $('btn-run').disabled = false;
  }
}

$('btn-run').addEventListener('click', run);


// ---------------------------------------------------------------------------
// Presse-papiers
// ---------------------------------------------------------------------------
//
// Ce que l'on cherche à savoir : une écriture DIFFÉRÉE (hors du geste
// utilisateur) est-elle permise ? De cette réponse dépend le comportement de
// l'effacement automatique après copie d'un mot de passe.
//
// Mesuré dans Chromium au moment de l'écriture de ce test : permission
// `clipboard-write` à `granted`, document focalisé, et pourtant l'écriture
// différée est refusée. Le coffre arme alors un effacement au prochain clic.

const clipResults = document.getElementById('clip-results');

function clipLine(etat, titre, detail) {
  const li = document.createElement('li');
  li.className = 'diag-line diag-' + etat;
  const t = document.createElement('span');
  t.className = 'diag-line-title';
  t.textContent = ({ ok: '✓ ', ko: '✗ ', info: '• ' }[etat] || '') + titre;
  li.append(t);
  if (detail) {
    const d = document.createElement('span');
    d.className = 'diag-line-detail';
    d.textContent = detail;
    li.append(d);
  }
  clipResults.append(li);
}

async function ecrire(texte) {
  try {
    await navigator.clipboard.writeText(texte);
    return null;
  } catch (e) {
    return e.name + ' — ' + e.message;
  }
}

document.getElementById('btn-clip').addEventListener('click', async () => {
  clipResults.textContent = '';

  try {
    const perm = await navigator.permissions.query({ name: 'clipboard-write' });
    clipLine('info', 'Permission clipboard-write', perm.state);
  } catch {
    clipLine('info', 'Permission clipboard-write', 'non interrogeable sur ce navigateur');
  }

  // 1. Écriture immédiate, dans le geste du clic
  const err1 = await ecrire('coffre-test-' + Date.now());
  if (err1) {
    clipLine('ko', 'Écriture immédiate refusée', err1);
    clipLine('info', 'Conséquence', 'La copie de mot de passe ne fonctionnera pas sur ce navigateur.');
    return;
  }
  clipLine('ok', 'Écriture immédiate autorisée', 'la copie de mot de passe fonctionne');

  // 2. Écriture différée, hors du geste
  clipLine('info', "Test de l'écriture différée…", '3 secondes');
  await new Promise((r) => setTimeout(r, 3000));
  const err2 = await ecrire('');

  if (!err2) {
    clipLine('ok', 'Écriture différée autorisée',
      "L'effacement automatique fonctionne seul, sans intervention.");
  } else {
    clipLine('info', 'Écriture différée refusée', err2);
    clipLine('info', 'Comportement du coffre',
      "L'effacement est reporté à votre prochain clic dans l'application, "
      + "et le bandeau vous le dit explicitement. Rien n'est effacé en silence.");
  }
});


// ---------------------------------------------------------------------------
// Volume et performance
// ---------------------------------------------------------------------------
//
// À quoi ça sert : décider si les paramètres Argon2 retenus (64 Mio, 3 passes,
// 4 voies) restent tenables sur l'appareil le plus lent du parc, une fois le
// coffre rempli pour de vrai. Le seuil de gêne est d'environ 1,5 s au
// déverrouillage (README.md, section Performance).
//
// La mesure se fait sur un coffre fabriqué en mémoire, jamais enregistré : le
// vrai coffre n'est ni lu ni touché.

const perfResults = document.getElementById('perf-results');

function perfLine(etat, titre, detail) {
  const li = document.createElement('li');
  li.className = 'diag-line diag-' + etat;
  const t = document.createElement('span');
  t.className = 'diag-line-title';
  t.textContent = ({ ok: '✓ ', ko: '✗ ', info: '• ' }[etat] || '') + titre;
  li.append(t);
  if (detail) {
    const d = document.createElement('span');
    d.className = 'diag-line-detail';
    d.textContent = detail;
    li.append(d);
  }
  perfResults.append(li);
  return li;
}

const ms = (v) => Math.round(v) + ' ms';
const ko = (octets) => (octets / 1024).toFixed(1) + ' Ko';

// Laisse le navigateur peindre entre deux étapes, pour que l'avancement soit
// visible au lieu d'apparaître d'un bloc à la fin.
const respirer = () => new Promise((r) => setTimeout(r, 16));

// Contenu volontairement réaliste : des champs vides donneraient un fichier
// beaucoup plus petit que le vôtre et une mesure trop optimiste.
function remplir(db, n) {
  const noms = ['Banque', 'Boutique', 'Messagerie', 'Assurance', 'Impôts',
    'Mutuelle', 'Énergie', 'Téléphonie', 'Transport', 'Streaming'];
  const racine = db.getDefaultGroup();
  const groupes = ['Banques', 'Achats', 'Travail', 'Administration', 'Loisirs']
    .map((nom) => db.createGroup(racine, nom));

  for (let i = 0; i < n; i += 1) {
    const e = db.createEntry(groupes[i % groupes.length]);
    e.fields.set('Title', `${noms[i % noms.length]} ${i}`);
    e.fields.set('UserName', `utilisateur${i}@exemple.fr`);
    e.fields.set('Password', kdbxweb.ProtectedValue.fromString(
      `M0t-2-p@sse-tr3s-long-${i}-xyz`));
    e.fields.set('URL', `https://service-${i}.exemple.fr/connexion`);
    e.fields.set('Notes',
      `Compte ouvert en 2024. Question secrète : nom du premier animal. `
      + `Contact support : 01 23 45 67 ${String(i % 100).padStart(2, '0')}.`);
  }
}

/**
 * Chronomètre une dérivation Argon2 aux paramètres réels du coffre, en parlant
 * directement au worker.
 *
 * On court-circuite volontairement vaultCrypto.js : celui-ci passe par kdbxweb,
 * donc par crypto.subtle, indisponible hors HTTPS. Ici on ne veut que le coût
 * du KDF, qui lui ne dépend que de WebAssembly.
 */
function mesurerArgon2() {
  return new Promise((resolve, reject) => {
    const worker = new Worker('./js/argon2Worker.js');
    const fin = (fn) => (v) => { worker.terminate(); fn(v); };
    const ok = fin(resolve);
    const ko = fin(reject);

    const minuteur = setTimeout(
      () => ko(new Error('Argon2 n’a pas répondu en 120 s')), 120000);

    // Déclaré avant les gestionnaires pour que la lecture reste évidente : le
    // chronomètre part juste avant l'envoi, quelques lignes plus bas.
    let depart = 0;

    worker.onmessage = (e) => {
      clearTimeout(minuteur);
      if (e.data.ok) ok({ duree: performance.now() - depart, backend: e.data.backend });
      else ko(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      clearTimeout(minuteur);
      ko(new Error(e.message || 'worker Argon2 indisponible'));
    };

    depart = performance.now();
    worker.postMessage({
      id: 1,
      password: new Uint8Array(32).fill(7),
      salt: new Uint8Array(16).fill(9),
      memory: DEFAULT_KDF.memoryBytes / 1024,   // kibioctets, comme kdbxweb
      iterations: DEFAULT_KDF.iterations,
      length: 32,
      parallelism: DEFAULT_KDF.parallelism,
      type: 2,                                  // Argon2id
      version: 0x13,
    });
  });
}

document.getElementById('btn-perf').addEventListener('click', async () => {
  const bouton = document.getElementById('btn-perf');
  const verdictEl = document.getElementById('perf-verdict');
  const n = Number(document.getElementById('perf-count').value);

  perfResults.textContent = '';
  verdictEl.hidden = true;
  bouton.disabled = true;

  const PHRASE = 'phrase.de.mesure.sans.valeur';

  // Hors contexte sécurisé, le navigateur n'expose pas crypto.subtle. kdbxweb
  // bascule alors sur son chemin Node et échoue sur « a.randomBytes is not a
  // function », message qui n'apprend rien.
  //
  // Argon2, lui, n'a pas besoin de subtle : c'est du WebAssembly autonome. Or
  // c'est le terme dominant — environ 900 ms sur les 940 mesurées. On mesure
  // donc au moins celui-là, ce qui rend la page utile sur un téléphone relié au
  // serveur local, sans attendre un déploiement HTTPS.
  if (!window.isSecureContext || !(window.crypto && window.crypto.subtle)) {
    perfLine('info', 'Contexte non sécurisé', location.origin);
    perfLine('info', 'Mesure réduite',
      'Le coffre complet ne peut pas être fabriqué ici : son chiffrement '
      + 'repose sur crypto.subtle, que le navigateur réserve à HTTPS. Argon2 '
      + 'seul est mesurable, et c’est le coût dominant.');
    await respirer();
    try {
      const { duree, backend } = await mesurerArgon2();
      perfLine('ok', 'Argon2 seul (64 Mio, 3 passes, 4 voies)', ms(duree));
      perfLine('info', 'Implémentation utilisée', backend);
      perfLine('info', 'Déverrouillage complet, estimation',
        `${ms(duree + 60)} — Argon2 plus l’analyse du fichier, `
        + 'de l’ordre de 60 ms pour 1000 entrées d’après la mesure sur PC.');

      const gene = duree > 1500;
      verdictEl.hidden = false;
      verdictEl.className = 'diag-verdict ' + (gene ? 'diag-verdict-ko' : 'diag-verdict-ok');
      verdictEl.textContent = gene
        ? `Argon2 à ${ms(duree)} sur cet appareil, au-dessus du seuil de 1,5 s. `
          + 'Les paramètres du KDF sont à alléger, ou la biométrie devient '
          + 'indispensable ici.'
        : `Argon2 à ${ms(duree)} sur cet appareil, sous le seuil de 1,5 s. `
          + 'Les paramètres actuels tiennent.';
    } catch (err) {
      perfLine('ko', 'Mesure Argon2 interrompue', (err && err.message) || String(err));
    }
    bouton.disabled = false;
    return;
  }

  try {
    perfLine('info', `Fabrication de ${n} entrées…`, '');
    await respirer();

    let t = performance.now();
    const db = createVault(PHRASE, 'Coffre de mesure');
    remplir(db, n);
    perfLine('ok', 'Fabrication', ms(performance.now() - t));
    await respirer();

    t = performance.now();
    const octets = await saveVault(db);
    const tEnregistrement = performance.now() - t;
    perfLine('ok', 'Enregistrement (Argon2 + chiffrement)', ms(tEnregistrement));
    perfLine('ok', 'Taille du fichier', ko(octets.byteLength));
    perfLine('info', 'Implémentation Argon2 utilisée', argon2Backend.last || 'inconnue');
    perfLine('info', 'Paramètres du KDF',
      `${DEFAULT_KDF.memoryBytes / 1024 / 1024} Mio, `
      + `${DEFAULT_KDF.iterations} passes, ${DEFAULT_KDF.parallelism} voies`);
    await respirer();

    t = performance.now();
    await openVault(octets, PHRASE);
    const tOuverture = performance.now() - t;
    perfLine('ok', 'Déverrouillage (Argon2 + analyse)', ms(tOuverture));
    await respirer();

    // Fusion : deux copies du même coffre, l'une modifiée, comme deux appareils.
    const local = await openVault(octets, PHRASE);
    const distant = await openVault(octets, PHRASE);
    const cible = distant.getDefaultGroup().groups[0].entries[0];
    if (cible) {
      cible.pushHistory();
      cible.fields.set('Password', kdbxweb.ProtectedValue.fromString('modifié'));
      cible.times.update();
    }
    t = performance.now();
    local.merge(distant);
    const tFusion = performance.now() - t;
    perfLine('ok', 'Fusion seule (sans Argon2)', ms(tFusion));

    // Ce que coûte réellement une synchronisation : relire le coffre distant,
    // fusionner, puis réenregistrer. Deux Argon2 sur les trois termes.
    const tCycle = tOuverture + tFusion + tEnregistrement;
    perfLine('info', 'Cycle de synchronisation complet (estimation)', ms(tCycle));

    const gene = tOuverture > 1500;
    verdictEl.hidden = false;
    verdictEl.className = 'diag-verdict ' + (gene ? 'diag-verdict-ko' : 'diag-verdict-ok');
    verdictEl.textContent = gene
      ? `Déverrouillage à ${ms(tOuverture)} sur cet appareil, au-dessus du seuil `
        + `de 1,5 s. Les paramètres Argon2 sont à revoir à la baisse, ou la `
        + `biométrie (phase 5) devient indispensable ici.`
      : `Déverrouillage à ${ms(tOuverture)} sur cet appareil, sous le seuil de `
        + `1,5 s. Les paramètres actuels tiennent à ce volume.`;
  } catch (err) {
    perfLine('ko', 'Mesure interrompue', (err && err.message) || String(err));
  } finally {
    bouton.disabled = false;
  }
});
