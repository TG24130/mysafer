// Verrouillage automatique par inactivité.
//
// Le piège à éviter : ne PAS se reposer sur un seul setTimeout. Les
// navigateurs mobiles brident puis suspendent les minuteries d'un onglet passé
// en arrière-plan. Un téléphone rangé dans une poche pendant une heure peut
// donc revenir sans que la minuterie n'ait jamais tiré, et le coffre serait
// resté déverrouillé.
//
// La minuterie ne sert qu'au cas courant. La vérité, c'est l'horodatage de la
// dernière activité : `check()` compare l'heure réelle et verrouille si le
// délai est dépassé. app.js l'appelle au retour de l'arrière-plan, ce qui
// couvre le cas de la minuterie suspendue.
//
// L'horloge et les minuteries sont injectables pour que tests/lockTimer.test.mjs
// puisse simuler des heures qui passent sans attendre.

export function createLockTimer({
  timeoutMs,
  onLock,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs invalide : ' + timeoutMs);
  }
  if (typeof onLock !== 'function') {
    throw new TypeError('onLock doit être une fonction');
  }

  let armed = false;
  let lastActivity = 0;
  let handle = null;

  function cancelTimer() {
    if (handle !== null) {
      clearTimer(handle);
      handle = null;
    }
  }

  function scheduleTimer() {
    cancelTimer();
    // On planifie sur le temps restant exact, pas sur le délai complet : après
    // une reprise d'activité partielle le réveil doit tomber au bon moment.
    handle = setTimer(() => { handle = null; check(); }, remaining());
  }

  /** Temps restant avant verrouillage, en millisecondes. 0 si dépassé. */
  function remaining() {
    if (!armed) return timeoutMs;
    return Math.max(0, lastActivity + timeoutMs - now());
  }

  /** Verrouille si le délai est écoulé. Sans effet si déjà désarmé. */
  function check() {
    if (!armed) return false;
    if (now() - lastActivity < timeoutMs) {
      scheduleTimer();
      return false;
    }
    // Désarmer AVANT d'appeler onLock : si onLock déclenche indirectement une
    // activité (rendu, focus), on ne veut pas se réarmer sur un coffre fermé,
    // ni risquer un second appel.
    stop();
    onLock();
    return true;
  }

  /** Démarre le compte à rebours. Idempotent. */
  function start() {
    armed = true;
    lastActivity = now();
    scheduleTimer();
  }

  /** Arrête tout. Aucun verrouillage ne surviendra tant que start() n'est pas rappelé. */
  function stop() {
    armed = false;
    cancelTimer();
  }

  /** Signale une action de l'utilisateur : le compte à rebours repart de zéro. */
  function activity() {
    if (!armed) return;
    lastActivity = now();
    scheduleTimer();
  }

  return { start, stop, activity, check, remaining, isArmed: () => armed };
}

/** Délai retenu : 5 minutes. */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Branche un minuteur sur les événements réels du document.
 * Renvoie une fonction de détachement.
 */
export function attachActivityListeners(timer, target = document) {
  const onActivity = () => timer.activity();
  // 'pointerdown' et 'keydown' suffisent : ils couvrent souris, tactile et
  // clavier. On évite volontairement 'mousemove' et 'scroll', qui
  // réarmeraient le minuteur sur un simple frôlement ou une page qui bouge
  // toute seule.
  const events = ['pointerdown', 'keydown'];
  for (const e of events) target.addEventListener(e, onActivity, { passive: true });

  // Au retour de l'arrière-plan : vérifier l'heure réelle immédiatement.
  const onVisibility = () => { if (!document.hidden) timer.check(); };
  document.addEventListener('visibilitychange', onVisibility);

  // 'pageshow' couvre la restauration depuis le cache de navigation (bfcache),
  // où le script reprend sans être réexécuté.
  const onPageShow = () => timer.check();
  window.addEventListener('pageshow', onPageShow);

  return function detach() {
    for (const e of events) target.removeEventListener(e, onActivity);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pageshow', onPageShow);
  };
}
