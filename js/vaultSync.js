// Transport du coffre vers Firebase Storage.
//
// Ce module ne sait rien de la fusion : il ne fait que descendre et remonter un
// blob. Toute la logique délicate est dans js/mergeCycle.js, qui reçoit d'ici
// un objet { download, upload } et n'a jamais entendu parler de Firebase. La
// séparation est ce qui permet de tester la fusion sous Node.
//
// Un seul objet par utilisateur : users/{uid}/vault/db.kdbx. Le contenu est
// déjà chiffré par kdbxweb quand il arrive ici — Firebase ne stocke qu'un blob
// illisible, et les règles de sécurité Storage restreignent chaque utilisateur
// à son propre dossier.
import {
  getStorage,
  ref,
  uploadBytes,
  getBlob,
} from './vendor/firebase/firebase-storage.js';
import { firebaseApp } from './firebaseInit.js';
import { currentUid } from './firebaseAuth.js';

const storage = getStorage(firebaseApp);

export const VAULT_PATH = 'vault/db.kdbx';

function pathFor(uid) {
  return `users/${uid}/${VAULT_PATH}`;
}

/** Vrai si l'erreur signifie « le coffre distant n'existe pas encore ». */
function isMissing(err) {
  return err && err.code === 'storage/object-not-found';
}

/**
 * Vrai si la requête a échoué avant toute réponse du serveur.
 *
 * Deux causes très différentes produisent la même erreur côté JavaScript, car
 * le navigateur refuse par principe d'en dire plus : l'absence de réseau, et
 * le blocage CORS. C'est `navigator.onLine` qui les départage — voir
 * isOffline() et isBlocked() ci-dessous.
 */
function isNetworkFailure(err) {
  return Boolean(err)
    && (err.code === 'storage/retry-limit-exceeded'
      || err.code === 'storage/server-file-wrong-size'
      || err.code === 'storage/unknown'
      || err.name === 'TypeError');
}

/** Vrai si l'appareil est réellement hors ligne. Rien à corriger, réessayer plus tard. */
export function isOffline(err) {
  return navigator.onLine === false && isNetworkFailure(err);
}

/**
 * Vrai si le réseau fonctionne mais que la requête n'a jamais abouti.
 *
 * En pratique c'est CORS : Firebase Storage exige que l'origine du site soit
 * autorisée sur le bucket lui-même, autorisation distincte des règles de
 * sécurité et invisible depuis la console Firebase. Elle se pose avec
 * `gcloud storage buckets update --cors-file=` (voir cors.json à la racine).
 *
 * Ce cas a coûté une longue recherche parce qu'il était rapporté comme « pas de
 * réseau » : le message doit rester explicite.
 */
export function isBlocked(err) {
  return navigator.onLine !== false && isNetworkFailure(err);
}

/** Vrai si Storage a refusé l'accès : règles de sécurité, ou session expirée. */
export function isDenied(err) {
  return err && err.code === 'storage/unauthorized';
}

/**
 * Construit le transport attendu par syncVault().
 *
 * @param {string} [uid] identifiant du compte ; par défaut celui connecté.
 * @throws {Error} si personne n'est connecté — sans uid il n'y a pas de chemin.
 */
export function createVaultTransport(uid = currentUid()) {
  if (!uid) {
    throw new Error('Synchronisation impossible : aucun compte connecté.');
  }
  const chemin = pathFor(uid);

  return {
    /** @returns {Promise<ArrayBuffer|null>} null si aucun coffre distant. */
    async download() {
      try {
        const blob = await getBlob(ref(storage, chemin));
        return await blob.arrayBuffer();
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
    },

    /** @param {ArrayBuffer} bytes coffre chiffré, prêt à stocker. */
    async upload(bytes) {
      await uploadBytes(ref(storage, chemin), bytes, {
        contentType: 'application/octet-stream',
        // Repère lisible dans la console Firebase, sans rien révéler du contenu.
        customMetadata: { app: 'coffre', format: 'kdbx4' },
      });
    },
  };
}
