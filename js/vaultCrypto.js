// Couche cryptographique du coffre : branche Argon2 sur kdbxweb, puis expose
// la création, l'ouverture et l'écriture d'un fichier KDBX.
//
// kdbxweb est chargé en UMD par index.html (window.kdbxweb). Les deux
// implémentations d'Argon2 vivent dans js/argon2Worker.js. Tout est servi
// depuis la même origine, sinon le service worker ne les met pas en cache et le
// déverrouillage casse hors ligne (voir js/vendor/README.md).

const kdbxweb = window.kdbxweb;
if (!kdbxweb) {
  throw new Error('kdbxweb absent : index.html doit charger js/vendor/kdbxweb.min.js avant ce module.');
}

const { CryptoEngine } = kdbxweb;

// ---------------------------------------------------------------------------
// Adaptateur Argon2 — délégué à un worker
// ---------------------------------------------------------------------------

// kdbxweb attend :
//   (password, salt, memory, iterations, length, parallelism, type, version)
//     => Promise<ArrayBuffer>
//
// ATTENTION à l'unité de `memory` : kdbxweb divise déjà la valeur du fichier
// KDBX (exprimée en octets) par 1024 avant d'appeler cette fonction. On reçoit
// donc des KIBIOCTETS, ce qui est exactement l'unité attendue aussi bien par
// @noble/hashes (`m`) que par argon2-browser (`mem`). Ne surtout pas
// reconvertir : un facteur 1024 ici produirait un coffre que KeePassXC
// refuserait d'ouvrir.
//
// Le calcul lui-même part dans js/argon2Worker.js — le WebAssembly fige le fil
// principal pendant toute sa durée, ce qui rendait l'interface inerte au
// déverrouillage.

// Indique quelle implémentation a réellement servi au dernier calcul. Utile
// pour le diagnostic et pour la mesure de performance.
export const argon2Backend = { last: null };

let worker = null;
let nextId = 0;
const pending = new Map();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker('./js/argon2Worker.js');
  worker.onmessage = (e) => {
    const { id, ok, hash, backend, error } = e.data;
    const slot = pending.get(id);
    if (!slot) return;
    pending.delete(id);
    if (ok) {
      argon2Backend.last = backend;
      slot.resolve(hash);
    } else {
      slot.reject(new Error('Argon2 : ' + error));
    }
  };
  worker.onerror = (e) => {
    // Un worker mort ne se répare pas : on rejette tout ce qui attend et on
    // repart d'un worker neuf au prochain appel, plutôt que de laisser des
    // promesses pendantes pour toujours.
    const err = new Error('Worker Argon2 indisponible : ' + (e.message || 'erreur inconnue'));
    for (const slot of pending.values()) slot.reject(err);
    pending.clear();
    worker.terminate();
    worker = null;
  };
  return worker;
}

function argon2Impl(password, salt, memory, iterations, length, parallelism, type, version) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      ensureWorker().postMessage({
        id, password, salt, memory, iterations, length, parallelism, type, version,
      });
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });
}

CryptoEngine.setArgon2Impl(argon2Impl);

// ---------------------------------------------------------------------------
// Paramètres par défaut des nouveaux coffres
// ---------------------------------------------------------------------------

// Argon2id, 64 Mio, 3 passes, 4 voies. Volontairement au-dessus des valeurs par
// défaut de KeePass (qui vise aussi de vieilles machines). À réviser si la
// mesure sur téléphone dépasse ~1,5 s : voir README.md, section « Performance ».
const DEFAULT_KDF = {
  memoryBytes: 64 * 1024 * 1024,
  iterations: 3,
  parallelism: 4,
};

function applyDefaultKdf(db) {
  db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
  const kdfParams = db.header.kdfParameters;
  kdfParams.set('M', kdbxweb.VarDictionary.ValueType.UInt64,
    kdbxweb.Int64.from(DEFAULT_KDF.memoryBytes));
  kdfParams.set('I', kdbxweb.VarDictionary.ValueType.UInt64,
    kdbxweb.Int64.from(DEFAULT_KDF.iterations));
  kdfParams.set('P', kdbxweb.VarDictionary.ValueType.UInt32,
    DEFAULT_KDF.parallelism);
}

// ---------------------------------------------------------------------------
// API publique
// ---------------------------------------------------------------------------

function credentials(masterPassword) {
  return new kdbxweb.Credentials(
    kdbxweb.ProtectedValue.fromString(masterPassword)
  );
}

/** Crée un coffre vide. Renvoie l'instance Kdbx (non encore sérialisée). */
export function createVault(masterPassword, name = 'Coffre') {
  const db = kdbxweb.Kdbx.create(credentials(masterPassword), name);
  applyDefaultKdf(db);
  return db;
}

/**
 * Ouvre un coffre.
 * @param {ArrayBuffer} data contenu du fichier .kdbx
 * @throws {kdbxweb.KdbxError} code InvalidKey si le mot de passe est faux
 */
export function openVault(data, masterPassword) {
  return kdbxweb.Kdbx.load(data, credentials(masterPassword));
}

/** Sérialise le coffre. Renvoie un ArrayBuffer prêt à stocker ou exporter. */
export function saveVault(db) {
  return db.save();
}

// Signature d'un fichier KDBX : deux entiers 32 bits en tête. La vérifier est
// quasi gratuit et attrape ce qu'aucune autre garde ne voit — un tampon vide,
// tronqué, ou qui n'est pas un coffre. Un coffre en ligne corrompu a été écrit
// sans que rien ne s'en aperçoive le 2026-09-01 ; c'est la parade.
const KDBX_SIGNATURE = [0x9AA2D903, 0xB54BFB67];

// Un coffre vide sérialisé pèse déjà plus de 200 octets. En dessous, le tampon
// est tronqué, quelle que soit son en-tête.
const TAILLE_MINIMALE = 200;

/**
 * Le tampon a-t-il l'apparence d'un fichier KDBX complet ?
 *
 * Ne dit rien du contenu — seule l'ouverture le prouve, et elle coûte une
 * dérivation Argon2. Ce contrôle-ci sert à ne jamais écrire ni envoyer un
 * tampon manifestement inexploitable.
 */
export function ressembleAKdbx(bytes) {
  if (!bytes || bytes.byteLength < TAILLE_MINIMALE) return false;
  const vue = new DataView(bytes);
  return vue.getUint32(0, true) === KDBX_SIGNATURE[0]
    && vue.getUint32(4, true) === KDBX_SIGNATURE[1];
}

/** True si l'erreur correspond à un mot de passe maître incorrect. */
export function isWrongPassword(err) {
  return err instanceof kdbxweb.KdbxError
    && err.code === kdbxweb.Consts.ErrorCodes.InvalidKey;
}

/**
 * Mesure le temps de dérivation Argon2 du coffre, en millisecondes.
 * Sert à décider JS pur contre WASM (voir README.md). Volontairement exposé :
 * la mesure doit être faite sur l'appareil réel, pas estimée.
 */
export async function measureUnlock(data, masterPassword) {
  const t0 = performance.now();
  await openVault(data, masterPassword);
  return Math.round(performance.now() - t0);
}

export { kdbxweb, DEFAULT_KDF };
