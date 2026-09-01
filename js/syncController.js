// Orchestration de la synchronisation, côté navigateur.
//
// Assemble les quatre pièces qui ne se connaissent pas entre elles :
//   firebaseAuth.js   qui est connecté
//   vaultSync.js      le transport Firebase Storage
//   mergeCycle.js     la logique de fusion (testée sous Node)
//   vaultDb.js        le coffre local et la référence de fusion
//
// C'est le seul module qui les voit toutes. js/app.js ne parle qu'à celui-ci.
import { kdbxweb, openVault, saveVault } from './vaultCrypto.js';
import { saveVaultBytes, getMeta, setMeta, META } from './vaultDb.js';
import { createVaultTransport, isDenied, isOffline, isBlocked } from './vaultSync.js';
import { syncVault, CoffreDistantIllisible } from './mergeCycle.js';

export { CoffreDistantIllisible };
import { sauvegarder } from './vaultBackup.js';
import { currentUid } from './firebaseAuth.js';

/**
 * Relit un coffre distant avec les identifiants du coffre déjà ouvert.
 *
 * On réutilise `db.credentials` plutôt que de redemander la phrase maîtresse :
 * elle n'a pas à retraverser l'application, et la clé est déjà dérivée.
 */
function deserializeWith(db) {
  return (bytes) => kdbxweb.Kdbx.load(bytes, db.credentials);
}

/** Vrai si la synchronisation est possible ici et maintenant. */
export function canSync() {
  return currentUid() !== null && navigator.onLine !== false;
}

/**
 * Exécute un cycle complet pour le coffre ouvert, puis enregistre localement le
 * résultat fusionné et la nouvelle référence de fusion.
 *
 * @param {object} db coffre ouvert (instance Kdbx), fusionné sur place
 * @returns {Promise<{action: 'created'|'merged', bytes: ArrayBuffer}>}
 * @throws si personne n'est connecté, si Storage refuse, ou si le réseau tombe.
 *         L'appelant distingue les cas avec isDenied() et isOffline().
 */
/**
 * Deux coffres sans ancêtre commun : celui de cet appareil n'a jamais été
 * synchronisé, et un autre existe déjà en ligne. Fusionner n'aurait pas de
 * sens, et écraser l'un des deux doit être un choix explicite.
 */
export class ConflitCoffre extends Error {
  constructor(octetsDistants) {
    super('Un coffre différent existe déjà en ligne pour ce compte.');
    this.name = 'ConflitCoffre';
    this.octetsDistants = octetsDistants;
  }
}

export async function syncNow(db) {
  const transport = createVaultTransport();

  const state = {
    lastEditState: await getMeta(META.EDIT_STATE),
    lastSyncAt: await getMeta(META.LAST_SYNC),
  };

  // Garde-fou contre la perte silencieuse d'un coffre.
  //
  // Le cas se produit vraiment : la session Firebase est mémorisée par origine,
  // et l'application ne peut pas savoir qu'un coffre existe en ligne tant que
  // personne n'est connecté. Sur un appareil neuf, elle propose donc d'en
  // créer un ; si l'utilisateur le fait avant de se connecter, on se retrouve
  // avec deux coffres sans ancêtre commun.
  //
  // Sans ce test, la suite enverrait le coffre local par-dessus l'autre — un
  // coffre vide écrasant des années de mots de passe. `merge()` ne protège de
  // rien ici : il suppose une origine commune, que ces deux fichiers n'ont pas.
  if (!state.lastSyncAt && !state.lastEditState) {
    const octetsDistants = await transport.download();
    if (octetsDistants) throw new ConflitCoffre(octetsDistants);
  }

  const result = await syncVault({
    db,
    state,
    transport,
    serialize: saveVault,
    deserialize: deserializeWith(db),
  });

  // Dans cet ordre : le coffre d'abord, la référence ensuite. Si l'application
  // est fermée entre les deux, on repart d'une référence plus ancienne que le
  // coffre — la fusion suivante refera simplement un peu de travail. L'ordre
  // inverse laisserait une référence en avance sur le contenu, et des
  // modifications pourraient être considérées à tort comme déjà envoyées.
  await saveVaultBytes(result.bytes);
  await setMeta(META.EDIT_STATE, state.lastEditState);
  await setMeta(META.LAST_SYNC, state.lastSyncAt);

  // Copie horodatée, après coup et sans jamais faire échouer la synchronisation
  // — à ce stade le coffre est déjà en sécurité des deux côtés. sauvegarder()
  // ne lève pas : elle renvoie son échec, qu'on transmet à l'appelant sans en
  // faire une erreur.
  //
  // Une copie à chaque synchronisation peut sembler beaucoup ; ça ne l'est pas.
  // À ~71 Ko la copie et quelques synchronisations par jour, on reste sous 1 %
  // des quotas gratuits, et la rétention borne le nombre de fichiers.
  const backup = await sauvegarder(currentUid(), result.bytes);

  return { ...result, backup };
}

/**
 * Télécharge le coffre distant sans coffre local préalable — appareil neuf.
 * Ne déchiffre rien : la phrase maîtresse sera demandée ensuite.
 *
 * @returns {Promise<ArrayBuffer|null>} null si le compte n'a pas encore de coffre.
 */
export function downloadRemoteVault() {
  return createVaultTransport().download();
}

/**
 * Installe un coffre téléchargé comme coffre local, après vérification de la
 * phrase maîtresse.
 *
 * La vérification n'est pas une formalité : sans elle on écrirait dans
 * IndexedDB un fichier qu'on ne saurait pas rouvrir, en écrasant potentiellement
 * un coffre existant.
 *
 * @throws {kdbxweb.KdbxError} code InvalidKey si la phrase est fausse — à
 *         reconnaître avec isWrongPassword() de vaultCrypto.js.
 */
export async function adoptRemoteVault(bytes, masterPassword) {
  const db = await openVault(bytes, masterPassword);

  await saveVaultBytes(bytes);
  await setMeta(META.EDIT_STATE, db.getLocalEditState());
  await setMeta(META.LAST_SYNC, Date.now());

  return db;
}

/**
 * Résout un ConflitCoffre en faveur du coffre local : il écrase celui en ligne.
 *
 * Destructif pour le coffre distant, et c'est pourquoi rien ne l'appelle
 * automatiquement — l'autre coffre reste néanmoins récupérable dans
 * `history/`, la copie horodatée ayant été déposée avant.
 */
export async function remplacerDistant(db) {
  const transport = createVaultTransport();
  const bytes = await saveVault(db);

  // Une copie de ce qui va être écrasé, avant de l'écraser. Sans elle, cette
  // fonction serait une perte de données irréversible sur un simple clic.
  const uid = currentUid();
  const octetsDistants = await transport.download();
  if (octetsDistants) await sauvegarder(uid, octetsDistants);

  await transport.upload(bytes);
  await saveVaultBytes(bytes);
  await setMeta(META.EDIT_STATE, db.getLocalEditState());
  await setMeta(META.LAST_SYNC, Date.now());

  return { action: 'remplacé', bytes };
}

/** Horodatage de la dernière synchronisation réussie, ou null. */
export function lastSyncAt() {
  return getMeta(META.LAST_SYNC);
}

/**
 * Message court destiné à l'utilisateur pour une erreur de synchronisation.
 * Le coffre local n'étant jamais mis en péril par un échec de synchro, ces
 * messages informent sans alarmer.
 */
/**
 * Code court et stable désignant une panne, à citer dans un signalement.
 *
 * Le message affiché change avec la rédaction ; ce code, non. Il dit d'un seul
 * mot où chercher, ce qui a manqué le 2026-09-01 : deux heures ont été perdues
 * à distinguer une panne réseau d'un fichier distant corrompu, faute d'un
 * repère que l'utilisateur puisse simplement lire et transmettre.
 */
export function codeIncident(err) {
  if (!err) return 'SYNC-OK';
  if (err.name === 'CoffreDistantIllisible') {
    // La cause distingue les deux seules issues : réparer, ou fusionner.
    const cause = err.cause && err.cause.message ? err.cause.message : '';
    if (/gzip|corrupt|inflate/i.test(cause)) return 'SYNC-DISTANT-CORROMPU';
    if (/key|password|clé/i.test(cause)) return 'SYNC-DISTANT-AUTRE-PHRASE';
    return 'SYNC-DISTANT-ILLISIBLE';
  }
  if (err.name === 'ConflitCoffre') return 'SYNC-DEUX-COFFRES';
  // kdbxweb refuse de fusionner deux objets de même identifiant. La fusion
  // s'arrête avant tout envoi : rien n'est écrasé, mais plus rien ne passe.
  if (/MergeError/.test(err.message || '')) return 'SYNC-FUSION-DOUBLON';
  if (isOffline(err)) return 'RESEAU-ABSENT';
  if (isBlocked(err)) return 'CORS-NON-AUTORISE';
  if (isDenied(err)) return 'ACCES-REFUSE';
  if (/aucun compte connecté/i.test(err.message || '')) return 'NON-CONNECTE';
  if (/Refus d’envoyer|Refus d’écrire/.test(err.message || '')) return 'COFFRE-INVALIDE';
  if (/Argon2|Worker/i.test(err.message || '')) return 'ARGON2';
  if (err.name === 'QuotaExceededError' || /quota/i.test(err.message || '')) return 'STOCKAGE-PLEIN';
  return 'INCONNU';
}

export function syncErrorMessage(err) {
  if (isOffline(err)) return 'Pas de réseau — le coffre reste utilisable hors ligne.';
  if (isBlocked(err)) {
    return 'Le serveur ne répond pas alors que le réseau fonctionne : '
      + 'l’origine de ce site n’est probablement pas autorisée sur le bucket '
      + '(configuration CORS, voir cors.json).';
  }
  if (isDenied(err)) return 'Accès refusé par le serveur. Reconnecte-toi.';
  if (err && /aucun compte connecté/i.test(err.message)) return 'Non connecté — synchronisation en pause.';

  // Repli. Il servait jusqu'ici un message qui ne disait rien, et l'erreur
  // n'était consignée nulle part : devant un échec, il n'y avait littéralement
  // rien à regarder. On y joint donc ce qui identifie la panne — le code
  // Firebase quand il y en a un, le message sinon.
  const detail = (err && (err.code || err.message)) || '';
  return detail
    ? 'Synchronisation impossible : ' + detail
    : 'Synchronisation impossible pour le moment.';
}
