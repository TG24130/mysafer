// Copie de secrets dans le presse-papiers, avec purge automatique.
//
// CONTRAINTE MESURÉE, et non supposée : écrire dans le presse-papiers exige une
// « activation transitoire » — un geste récent de l'utilisateur. Vérifié dans
// Chromium : avec la permission `clipboard-write` à l'état `granted` et le
// document focalisé, un `writeText()` hors geste échoue quand même
// (`NotAllowedError — Write permission denied`).
//
// Une purge par simple setTimeout ne s'exécute donc JAMAIS. La première version
// de ce module faisait exactement cela, et l'interface annonçait « Copié 25s »
// alors que le mot de passe restait indéfiniment dans le presse-papiers. Un
// échec silencieux est ici pire que pas de purge du tout : il donne une fausse
// assurance.
//
// D'où le fonctionnement retenu :
//   1. au bout du délai, on tente l'écriture directe ;
//   2. si elle échoue, on arme un déclencheur à usage unique sur le prochain
//      geste de l'utilisateur — un geste rend l'écriture possible ;
//   3. l'état réel est remonté à l'interface, qui n'annonce que ce qui s'est
//      vraiment produit.
//
// Limite résiduelle assumée : la purge ne peut pas vérifier que c'est bien
// notre valeur qui se trouve encore dans le presse-papiers, car lire demande
// une permission que ce coffre ne réclame pas (`clipboard-read` est d'ailleurs
// à `denied` par défaut). Si l'utilisateur copie autre chose entre-temps depuis
// une autre application, la purge effacera sa sélection. Compromis retenu :
// mieux vaut effacer un texte anodin que laisser traîner un mot de passe.

/** Délai avant tentative de purge, en millisecondes. */
export const DEFAULT_CLEAR_MS = 25 * 1000;

/** États possibles, remontés à l'interface. */
export const STATE = {
  IDLE: 'idle',              // rien en cours
  PENDING: 'pending',        // purge programmée
  CLEARED: 'cleared',        // presse-papiers effacé
  AWAITING_GESTURE: 'awaiting-gesture', // effacement au prochain geste
  FAILED: 'failed',          // échec définitif
};

const GESTURE_EVENTS = ['pointerdown', 'keydown'];

let pendingTimer = null;
let gestureArmed = false;
let listeners = [];
let state = STATE.IDLE;

/** S'abonner aux changements d'état. Renvoie une fonction de désabonnement. */
export function onStateChange(fn) {
  listeners.push(fn);
  return () => { listeners = listeners.filter((l) => l !== fn); };
}

function setState(next) {
  state = next;
  for (const fn of listeners) {
    try { fn(next); } catch { /* un abonné fautif ne doit rien casser */ }
  }
}

export function getState() {
  return state;
}

function disarmGesture() {
  if (!gestureArmed) return;
  for (const e of GESTURE_EVENTS) document.removeEventListener(e, onGesture, true);
  gestureArmed = false;
}

function armGesture() {
  if (gestureArmed) return;
  for (const e of GESTURE_EVENTS) document.addEventListener(e, onGesture, true);
  gestureArmed = true;
  setState(STATE.AWAITING_GESTURE);
}

async function onGesture() {
  disarmGesture();
  // On est dans un geste utilisateur : l'écriture est maintenant permise.
  setState((await write('')) ? STATE.CLEARED : STATE.FAILED);
}

async function write(texte) {
  try {
    await navigator.clipboard.writeText(texte);
    return true;
  } catch {
    return false;
  }
}

/** Annule toute purge programmée ou armée, sans toucher au presse-papiers. */
export function cancelPendingClear() {
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  disarmGesture();
}

/**
 * Tente d'effacer le presse-papiers immédiatement.
 * Si l'écriture est refusée faute de geste utilisateur, arme un effacement au
 * prochain geste plutôt que d'échouer en silence.
 * @param {boolean} armerSiRefus false pour ne pas armer (fermeture de page)
 */
export async function clearNow(armerSiRefus = true) {
  cancelPendingClear();
  if (await write('')) {
    setState(STATE.CLEARED);
    return true;
  }
  if (armerSiRefus) armGesture();
  else setState(STATE.FAILED);
  return false;
}

/**
 * Copie un secret et programme sa purge.
 * À appeler DANS un gestionnaire d'événement utilisateur, sinon l'écriture
 * initiale échouera elle aussi.
 * @returns {Promise<boolean>} true si l'écriture a réussi
 */
export async function copySecret(text, clearAfterMs = DEFAULT_CLEAR_MS) {
  cancelPendingClear();
  if (!text) return false;
  if (!(await write(text))) {
    setState(STATE.FAILED);
    return false;
  }
  setState(STATE.PENDING);
  pendingTimer = setTimeout(() => { pendingTimer = null; clearNow(true); }, clearAfterMs);
  return true;
}

/** True si une purge est programmée ou armée. */
export function hasPendingClear() {
  return pendingTimer !== null || gestureArmed;
}

/** Message court décrivant l'état, ou '' si rien à signaler. */
export function stateMessage(s = state) {
  switch (s) {
    case STATE.PENDING: return 'Mot de passe copié — effacement automatique';
    case STATE.CLEARED: return 'Presse-papiers effacé';
    case STATE.AWAITING_GESTURE: return 'Presse-papiers effacé à votre prochain clic';
    case STATE.FAILED: return 'Effacement du presse-papiers impossible — videz-le vous-même';
    default: return '';
  }
}

/** Remet le module à zéro. Réservé aux tests. */
export function _reset() {
  cancelPendingClear();
  listeners = [];
  state = STATE.IDLE;
}
