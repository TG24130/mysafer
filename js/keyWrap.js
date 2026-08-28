// Emballage de la phrase maîtresse par une clé dérivée d'un secret d'appareil.
//
// Ce module ne connaît ni WebAuthn ni le DOM : il reçoit un secret brut (en
// pratique la sortie PRF de l'authentificateur) et rend un paquet chiffré.
// C'est ce qui le rend testable sous Node, où WebCrypto existe mais pas
// WebAuthn — voir tests/keyWrap.test.mjs.
//
// Ce qui est emballé, et pourquoi ce n'est pas la clé maître du coffre :
// kdbxweb n'expose pas la clé dérivée par Argon2, seulement les identifiants
// qui servent à la produire. On emballe donc la phrase elle-même. La
// conséquence est que le déverrouillage biométrique refait la dérivation
// Argon2 — 209 ms sur iPhone, environ 1,2 s sur PC de bureau. L'intérêt n'est
// pas la vitesse mais de ne plus ressaisir six mots à chaque ouverture.
//
// Ce que ce montage protège, et ce qu'il ne protège pas. Le paquet chiffré vit
// dans IndexedDB ; le secret qui l'ouvre ne quitte jamais l'authentificateur et
// n'est produit qu'après vérification biométrique. Quelqu'un qui copierait le
// stockage du navigateur n'en tirerait rien. En revanche, la sortie PRF
// compromise expose la phrase : c'est le même niveau de confiance que celui
// accordé à l'appareil lui-même.

const ITERATIONS_INFO = 'coffre-emballage-phrase-v1';

const encodeur = new TextEncoder();
const decodeur = new TextDecoder();

/** Octets vers base64, pour stockage dans IndexedDB et lisibilité au débogage. */
export function versBase64(octets) {
  let binaire = '';
  for (const o of new Uint8Array(octets)) binaire += String.fromCharCode(o);
  return btoa(binaire);
}

/** Inverse de versBase64. */
export function depuisBase64(texte) {
  const binaire = atob(texte);
  const out = new Uint8Array(binaire.length);
  for (let i = 0; i < binaire.length; i += 1) out[i] = binaire.charCodeAt(i);
  return out;
}

/**
 * Dérive une clé AES-GCM à partir du secret d'appareil.
 *
 * HKDF plutôt qu'un usage direct de la sortie PRF : celle-ci est un secret de
 * 32 octets dont on ne connaît pas la distribution exacte, et dont on veut
 * pouvoir tirer plusieurs clés distinctes à l'avenir sans les corréler.
 */
async function deriverCle(secret, sel) {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: sel, info: encodeur.encode(ITERATIONS_INFO) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Emballe une phrase maîtresse.
 *
 * @param {string} phrase       phrase de passe maître, en clair
 * @param {Uint8Array} secret   secret d'appareil (sortie PRF, 32 octets)
 * @returns {Promise<{sel: string, iv: string, contenu: string, version: number}>}
 *          paquet sérialisable, sans aucun secret en clair
 */
export async function emballer(phrase, secret) {
  const sel = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cle = await deriverCle(secret, sel);

  const contenu = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cle,
    encodeur.encode(phrase),
  );

  return {
    version: 1,
    sel: versBase64(sel),
    iv: versBase64(iv),
    contenu: versBase64(contenu),
  };
}

/**
 * Déballe une phrase maîtresse.
 *
 * @throws {Error} si le secret ne correspond pas. AES-GCM étant authentifié,
 *         un mauvais secret échoue franchement au lieu de rendre une phrase
 *         fausse — ce qui produirait un « mot de passe incorrect » incompris.
 */
export async function deballer(paquet, secret) {
  if (!paquet || paquet.version !== 1) {
    throw new Error('Paquet d’emballage absent ou de version inconnue.');
  }
  const cle = await deriverCle(secret, depuisBase64(paquet.sel));

  let clair;
  try {
    clair = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: depuisBase64(paquet.iv) },
      cle,
      depuisBase64(paquet.contenu),
    );
  } catch {
    throw new Error('Le secret de cet appareil ne correspond pas à ce coffre.');
  }
  return decodeur.decode(clair);
}
