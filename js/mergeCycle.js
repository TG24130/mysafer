// Cycle de synchronisation d'un coffre KDBX : télécharger, fusionner, renvoyer.
//
// Ce module ignore délibérément Firebase et le navigateur. Il reçoit un
// « transport » (deux fonctions, download et upload) et deux fonctions de
// (dé)sérialisation. Il est donc exécutable sous Node, ce qui permet à
// tests/mergeLogic.test.mjs de simuler deux appareils sans réseau ni compte.
//
// La séparation est volontaire : c'est la fusion qui est délicate, pas le
// transport. L'incident Firestore du 05/08/2026 sur Gestion Loc SCI venait
// d'écritures concurrentes qui s'écrasaient au lieu de fusionner, et n'avait
// été découvert qu'en production faute de pouvoir tester la fusion hors ligne.

/**
 * État de synchronisation à conserver entre deux appels, par appareil.
 * `lastEditState` est l'instantané kdbxweb du coffre tel qu'il était à la
 * dernière synchronisation réussie. C'est la référence qui permet à `merge()`
 * de distinguer « modifié ici depuis la dernière synchro » de « jamais connu ».
 */
export function createSyncState() {
  return { lastEditState: null, lastSyncAt: null };
}

/**
 * Exécute un cycle complet.
 *
 * @param {object}   o
 * @param {object}   o.db           coffre local (instance Kdbx), modifié sur place
 * @param {object}   o.state        objet issu de createSyncState(), modifié sur place
 * @param {object}   o.transport    { download(): Promise<ArrayBuffer|null>,
 *                                    upload(ArrayBuffer): Promise<void> }
 * @param {Function} o.serialize    (db) => Promise<ArrayBuffer>
 * @param {Function} o.deserialize  (ArrayBuffer) => Promise<Kdbx>
 * @param {Function} [o.now]        source de temps, injectable pour les tests
 * @returns {Promise<{action: 'created'|'merged', bytes: ArrayBuffer}>}
 *
 * `bytes` est le coffre tel qu'il vient d'être envoyé. L'appelant doit
 * l'enregistrer localement plutôt que de re-sérialiser : chaque sérialisation
 * refait une dérivation Argon2 de 64 Mio, soit une à deux secondes sur
 * téléphone.
 */
export async function syncVault({ db, state, transport, serialize, deserialize, now = () => Date.now() }) {
  const remoteBytes = await transport.download();

  // Aucun coffre distant : premier envoi. Rien à fusionner.
  if (!remoteBytes) {
    const bytes = await serialize(db);
    await transport.upload(bytes);
    state.lastEditState = db.getLocalEditState();
    state.lastSyncAt = now();
    return { action: 'created', bytes };
  }

  const remoteDb = await deserialize(remoteBytes);

  // Cœur du dispositif, dans cet ordre précis.
  //
  // setLocalEditState replace le coffre local devant l'état qu'il avait à la
  // dernière synchronisation, comme le prescrit la marche à suivre publiée par
  // kdbxweb.
  //
  // Honnêteté sur sa portée : aucun des scénarios de tests/mergeLogic.test.mjs
  // ne montre le moindre écart quand on retire cet appel, redémarrage de
  // l'application compris. La raison tient à la façon dont KDBX enregistre les
  // choses — une suppression est un déplacement daté vers la corbeille, inscrit
  // dans le fichier, et une modification est arbitrée par lastModTime. La
  // fusion n'a donc pas besoin qu'on lui rappelle ce qui avait changé depuis la
  // dernière fois. L'appel est conservé parce qu'il est sans coût et qu'il
  // pourrait compter dans des cas non couverts ; le test « retirer la référence
  // ne change rien » fige ce constat et alertera si une version ultérieure de
  // kdbxweb modifie ce comportement.
  //
  // Ce qui compte vraiment, en revanche, est ailleurs : kdbxweb ne met PAS à
  // jour lastModTime tout seul quand un champ change. Toute modification doit
  // passer par entry.times.update() — faute de quoi deux appareils divergent
  // en silence et définitivement. js/app.js le fait ; ne pas l'oublier ailleurs.
  if (state.lastEditState) db.setLocalEditState(state.lastEditState);
  db.merge(remoteDb);

  // On renvoie le résultat fusionné, jamais l'état local d'avant fusion.
  const bytes = await serialize(db);
  await transport.upload(bytes);

  // Nouvelle référence pour le prochain cycle. À ne prendre qu'après un envoi
  // réussi : si l'envoi échoue, l'ancienne référence reste valable et le cycle
  // suivant refusionnera correctement.
  state.lastEditState = db.getLocalEditState();
  state.lastSyncAt = now();
  return { action: 'merged', bytes };
}

/**
 * Limite connue et assumée : Firebase Storage n'offre pas d'écriture
 * conditionnelle (pas d'équivalent d'un If-Match sur une version). Deux
 * appareils qui terminent leur cycle exactement en même temps peuvent donc
 * s'écraser l'un l'autre : le dernier envoi gagne, et les modifications de
 * l'autre appareil restent dans son coffre local jusqu'à sa synchronisation
 * suivante, qui les refusionnera.
 *
 * Fusionner-avant-d'envoyer rend l'état convergent, il ne le rend pas
 * transactionnel. Les copies horodatées de la phase 6 sont le filet prévu pour
 * ce cas.
 */
export const SYNC_LIMITS = Object.freeze({
  conditionalWrite: false,
  convergent: true,
  transactional: false,
});
