// Ouverture biométrique par WebAuthn, extension PRF.
//
// Une passkey ordinaire authentifie : elle prouve qui vous êtes, elle ne
// fournit aucune clé. L'extension PRF ajoute ce qui manque — l'authentificateur
// dérive, à partir d'un sel qu'on lui donne, un secret de 32 octets qu'il est
// seul à pouvoir reproduire, et seulement après vérification biométrique.
//
// Ce secret sert à emballer la phrase maîtresse (js/keyWrap.js). Il n'est jamais
// stocké : il est recalculé à chaque déverrouillage.
//
// Trois contraintes tenues explicitement, issues du plan :
//
//   1. Sur un appareil neuf, la phrase maîtresse d'abord, toujours. Le paquet
//      emballé vit dans IndexedDB, donc par appareil : un appareil qui n'a rien
//      ne peut rien déballer, et le chemin par la phrase reste le seul.
//   2. PRF n'est pas universellement disponible. On détecte, on masque
//      l'option, et on ne retire jamais le chemin par la phrase maîtresse.
//   3. L'enrôlement est lié au domaine (`rpId`). Changer d'adresse casserait
//      tous les enrôlements existants — c'est pourquoi il se fait sur le
//      domaine définitif, pas sur localhost.
import { getMeta, setMeta, deleteMeta, META } from './vaultDb.js';
import { emballer, deballer, versBase64, depuisBase64 } from './keyWrap.js';

const NOM_AFFICHE = 'Coffre';

/**
 * Cet appareil peut-il servir au déverrouillage biométrique ?
 *
 * Réponse prudente : on vérifie le contexte sécurisé, la présence de l'API et
 * celle d'un authentificateur de plateforme. Le support réel de PRF, lui, ne se
 * découvre qu'à l'enrôlement — d'où la page de diagnostic, qui va jusqu'au bout
 * et vérifie en plus le déterminisme.
 */
export async function biometrieDisponible() {
  if (!window.isSecureContext || !window.PublicKeyCredential) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/** Un enrôlement existe-t-il sur cet appareil, pour ce coffre ? */
export async function estEnrole() {
  const [paquet, id] = await Promise.all([
    getMeta(META.WRAPPED_KEY),
    getMeta(META.CREDENTIAL_ID),
  ]);
  return Boolean(paquet && id);
}

/** Obtient la sortie PRF pour un enrôlement donné. Déclenche la biométrie. */
async function sortiePrf(credentialId, selPrf) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      allowCredentials: [{ type: 'public-key', id: credentialId }],
      userVerification: 'required',
      timeout: 120000,
      extensions: { prf: { eval: { first: selPrf } } },
    },
  });

  const ext = assertion.getClientExtensionResults();
  const sortie = ext.prf && ext.prf.results ? ext.prf.results.first : null;
  if (!sortie) {
    throw new Error(
      'Cet appareil a bien vérifié votre identité, mais n’a renvoyé aucune '
      + 'valeur PRF. Le déverrouillage biométrique n’y est pas utilisable.',
    );
  }
  return new Uint8Array(sortie);
}

/**
 * Enrôle cet appareil. À n'appeler que coffre déjà ouvert : c'est la preuve que
 * la phrase fournie est la bonne.
 *
 * @param {string} phrase phrase maîtresse en clair
 */
export async function enroler(phrase) {
  const selPrf = crypto.getRandomValues(new Uint8Array(32));

  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: NOM_AFFICHE, id: location.hostname },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: NOM_AFFICHE,
        displayName: NOM_AFFICHE,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },     // ES256
        { type: 'public-key', alg: -257 },   // RS256
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

  // Deuxième vérification biométrique, immédiatement : plusieurs navigateurs ne
  // renvoient pas la sortie PRF à la création, seulement à l'authentification.
  // Deux invites de suite surprennent, mais c'est le seul moyen d'obtenir le
  // secret — et de vérifier tout de suite qu'il existe vraiment sur cet
  // appareil, plutôt que de le découvrir au premier déverrouillage.
  const secret = await sortiePrf(credential.rawId, selPrf);

  const paquet = await emballer(phrase, secret);
  paquet.selPrf = versBase64(selPrf);

  await setMeta(META.WRAPPED_KEY, paquet);
  await setMeta(META.CREDENTIAL_ID, versBase64(credential.rawId));
}

/**
 * Déverrouille par biométrie.
 * @returns {Promise<string>} la phrase maîtresse
 */
export async function deverrouiller() {
  const paquet = await getMeta(META.WRAPPED_KEY);
  const idBase64 = await getMeta(META.CREDENTIAL_ID);
  if (!paquet || !idBase64) {
    throw new Error('Aucun enrôlement biométrique sur cet appareil.');
  }

  const secret = await sortiePrf(depuisBase64(idBase64), depuisBase64(paquet.selPrf));
  return deballer(paquet, secret);
}

/**
 * Retire l'enrôlement de cet appareil.
 *
 * La clé WebAuthn elle-même n'est pas supprimée : aucune API ne le permet
 * depuis une page. Elle devient simplement inutilisée, et se supprime dans les
 * réglages du système ou du navigateur. Le paquet emballé, lui, disparaît —
 * c'est ce qui compte, il devient impossible de déballer quoi que ce soit.
 */
export async function desactiver() {
  await deleteMeta(META.WRAPPED_KEY);
  await deleteMeta(META.CREDENTIAL_ID);
}

/** Message destiné à l'utilisateur pour une erreur d'enrôlement ou d'ouverture. */
export function messageErreur(err) {
  if (!err) return 'Échec de la biométrie.';
  if (err.name === 'NotAllowedError') {
    return 'Vérification annulée ou expirée.';
  }
  if (err.name === 'InvalidStateError') {
    return 'Cet appareil possède déjà une clé pour ce coffre.';
  }
  if (err.name === 'NotSupportedError') {
    return 'Cet appareil ne gère pas le type de clé demandé.';
  }
  return err.message || 'Échec de la biométrie.';
}
