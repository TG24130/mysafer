// Stockage local du coffre dans IndexedDB.
//
// Ce qui est stocké ici est le fichier .kdbx CHIFFRÉ, tel qu'il serait sur
// disque. La clé maître n'y est jamais écrite : elle ne vit qu'en mémoire, le
// temps de la session déverrouillée.
//
// Deux magasins :
//   vault  — le blob .kdbx (clé fixe 'current')
//   meta   — métadonnées de synchronisation et d'appareil (clé libre)
//
// Modèle repris de webapp/js/filesDb.js (Gestion Loc SCI).

const DB_NAME = 'coffre_db';
const DB_VERSION = 1;
const STORE_VAULT = 'vault';
const STORE_META = 'meta';
const VAULT_KEY = 'current';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_VAULT)) db.createObjectStore(STORE_VAULT);
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, run) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = run(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

// ---------------------------------------------------------------------------
// Coffre
// ---------------------------------------------------------------------------

/** @returns {Promise<ArrayBuffer|null>} */
export function loadVaultBytes() {
  return tx(STORE_VAULT, 'readonly', (s) => s.get(VAULT_KEY))
    .then((v) => v || null);
}

/** @param {ArrayBuffer} bytes */
export function saveVaultBytes(bytes) {
  return tx(STORE_VAULT, 'readwrite', (s) => s.put(bytes, VAULT_KEY));
}

export function hasVault() {
  return loadVaultBytes().then((v) => v !== null);
}

/**
 * Efface le coffre local ET ses métadonnées.
 * Destructif : si le coffre n'est pas synchronisé ou exporté par ailleurs, son
 * contenu est définitivement perdu. Réservé à une action explicite de
 * l'utilisateur, jamais appelé automatiquement.
 */
export async function destroyLocalVault() {
  await tx(STORE_VAULT, 'readwrite', (s) => s.clear());
  await tx(STORE_META, 'readwrite', (s) => s.clear());
}

// ---------------------------------------------------------------------------
// Métadonnées
// ---------------------------------------------------------------------------

export function getMeta(key) {
  return tx(STORE_META, 'readonly', (s) => s.get(key))
    .then((v) => (v === undefined ? null : v));
}

export function setMeta(key, value) {
  return tx(STORE_META, 'readwrite', (s) => s.put(value, key));
}

export function deleteMeta(key) {
  return tx(STORE_META, 'readwrite', (s) => s.delete(key));
}

// Clés de métadonnées utilisées par le reste de l'application. Centralisées
// ici pour éviter les chaînes magiques dispersées.
export const META = {
  // État d'édition kdbxweb (getLocalEditState), nécessaire à la fusion.
  EDIT_STATE: 'editState',
  // Horodatage de la dernière synchronisation réussie.
  LAST_SYNC: 'lastSync',
  // Clé maître emballée par WebAuthn PRF (phase 5).
  WRAPPED_KEY: 'wrappedKey',
  // Identifiant de credential WebAuthn de cet appareil (phase 5).
  CREDENTIAL_ID: 'credentialId',
  // Dernier export manuel, pour le rappel de sauvegarde (phase 6).
  LAST_EXPORT: 'lastExport',
};
