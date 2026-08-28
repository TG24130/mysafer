// Copies horodatées du coffre dans Firebase Storage.
//
// Chemin : users/{uid}/vault/history/{horodatage}.kdbx, à côté du coffre
// courant users/{uid}/vault/db.kdbx. Le contenu est le même blob chiffré :
// aucune de ces copies n'est lisible sans la phrase maîtresse.
//
// Ce que ça protège — et ce que ça ne protège pas. Perdre la phrase maîtresse
// reste un risque accepté (décision 3) : ces copies n'y changent rien. Ce
// qu'elles rattrapent, c'est la perte du blob : une mauvaise fusion, une
// suppression regrettée, ou deux envois simultanés qui s'écrasent — Firebase
// Storage n'ayant pas d'écriture conditionnelle (voir SYNC_LIMITS dans
// js/mergeCycle.js).
//
// La décision de quoi garder vit dans js/backupPolicy.js, sans dépendance à
// Firebase, pour être testable sous Node.
import {
  getStorage, ref, uploadBytes, deleteObject, listAll,
} from './vendor/firebase/firebase-storage.js';
import { firebaseApp } from './firebaseInit.js';
import { nomDeCopie, dateDeCopie, trierCopies } from './backupPolicy.js';

const storage = getStorage(firebaseApp);

const dossierHistorique = (uid) => `users/${uid}/vault/history`;

/**
 * Liste les copies reconnues.
 *
 * Les fichiers dont le nom ne suit pas le format sont **ignorés**, donc jamais
 * supprimés : un fichier déposé à la main dans ce dossier doit survivre à la
 * rotation.
 *
 * @returns {Promise<Array<{nom: string, date: Date}>>}
 */
export async function listerCopies(uid) {
  const { items } = await listAll(ref(storage, dossierHistorique(uid)));
  return items
    .map((item) => ({ nom: item.name, date: dateDeCopie(item.name) }))
    .filter((c) => c.date !== null);
}

/** Dépose une copie horodatée. */
export async function ecrireCopie(uid, bytes, date = new Date()) {
  const nom = nomDeCopie(date);
  await uploadBytes(ref(storage, `${dossierHistorique(uid)}/${nom}`), bytes, {
    contentType: 'application/octet-stream',
    customMetadata: { app: 'coffre', format: 'kdbx4', role: 'historique' },
  });
  return nom;
}

/**
 * Applique la politique de rétention.
 *
 * Les suppressions sont faites une par une et les échecs sont avalés
 * volontairement : ne pas réussir à supprimer une vieille copie est sans
 * conséquence, alors qu'interrompre la synchronisation pour ça en aurait une.
 *
 * @returns {Promise<{gardees: number, supprimees: number}>}
 */
export async function appliquerRotation(uid, maintenant = new Date()) {
  const copies = await listerCopies(uid);
  const { garder, supprimer } = trierCopies(copies, maintenant);

  let supprimees = 0;
  for (const nom of supprimer) {
    try {
      await deleteObject(ref(storage, `${dossierHistorique(uid)}/${nom}`));
      supprimees += 1;
    } catch {
      // Copie déjà supprimée par un autre appareil, ou refus temporaire.
    }
  }
  return { gardees: garder.length, supprimees };
}

/**
 * Écrit une copie puis fait le ménage. À appeler après un envoi réussi.
 *
 * Ne lève jamais : une sauvegarde qui échoue ne doit pas faire échouer la
 * synchronisation, dont le résultat est déjà en sécurité à ce stade.
 *
 * @returns {Promise<{ok: boolean, nom?: string, gardees?: number,
 *                    supprimees?: number, erreur?: Error}>}
 */
export async function sauvegarder(uid, bytes, maintenant = new Date()) {
  try {
    const nom = await ecrireCopie(uid, bytes, maintenant);
    const { gardees, supprimees } = await appliquerRotation(uid, maintenant);
    return { ok: true, nom, gardees, supprimees };
  } catch (erreur) {
    return { ok: false, erreur };
  }
}
