// Tests du verrouillage par inactivité (js/lockTimer.js).
//
// Aucune attente réelle : l'horloge et les minuteries sont injectées, ce qui
// permet de simuler des heures en quelques millisecondes. C'est aussi la
// seule façon de tester le cas qui compte vraiment — la minuterie suspendue
// par un téléphone en arrière-plan.
//
// Lancer :  node tests/lockTimer.test.mjs

import assert from 'node:assert/strict';
import { createLockTimer, DEFAULT_TIMEOUT_MS } from '../js/lockTimer.js';

let ok = 0;
function test(nom, fn) {
  try {
    fn();
    ok++;
    console.log('  ok   ' + nom);
  } catch (e) {
    console.error('  ECHEC ' + nom + '\n        ' + e.message);
    process.exitCode = 1;
  }
}

/**
 * Horloge et ordonnanceur simulés.
 * `advance` fait avancer le temps ET déclenche les minuteries échues, comme le
 * ferait un navigateur actif. `jump` fait avancer le temps SANS déclencher
 * quoi que ce soit : c'est le comportement d'un onglet mis en veille.
 */
function fakeClock() {
  let t = 1000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    advance(ms) {
      const cible = t + ms;
      // Déclenche les minuteries dans l'ordre chronologique.
      for (;;) {
        let prochain = null;
        for (const [id, item] of timers) {
          if (item.at <= cible && (prochain === null || item.at < prochain.item.at)) {
            prochain = { id, item };
          }
        }
        if (!prochain) break;
        timers.delete(prochain.id);
        t = prochain.item.at;
        prochain.item.fn();
      }
      t = cible;
    },
    jump(ms) { t += ms; },
    pending: () => timers.size,
  };
}

function build(timeoutMs = 5000) {
  const clock = fakeClock();
  const locks = [];
  const timer = createLockTimer({
    timeoutMs,
    onLock: () => locks.push(clock.now()),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, locks, timer };
}

console.log('\nConstruction');

test('refuse un délai invalide', () => {
  for (const bad of [0, -1, NaN, undefined]) {
    assert.throws(() => createLockTimer({ timeoutMs: bad, onLock: () => {} }), RangeError);
  }
});

test('refuse un onLock qui n\'est pas une fonction', () => {
  assert.throws(() => createLockTimer({ timeoutMs: 1000 }), TypeError);
});

test('le délai par défaut est bien de 5 minutes', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 300000);
});

console.log('\nCompte à rebours');

test('ne verrouille pas avant le délai', () => {
  const { clock, locks, timer } = build(5000);
  timer.start();
  clock.advance(4999);
  assert.equal(locks.length, 0);
});

test('verrouille une fois le délai atteint', () => {
  const { clock, locks, timer } = build(5000);
  timer.start();
  clock.advance(5000);
  assert.equal(locks.length, 1);
});

test('ne verrouille qu\'une seule fois', () => {
  const { clock, locks, timer } = build(5000);
  timer.start();
  clock.advance(60000);
  assert.equal(locks.length, 1);
});

test('une activité repousse le verrouillage', () => {
  const { clock, locks, timer } = build(5000);
  timer.start();
  clock.advance(4000);
  timer.activity();
  clock.advance(4000);
  assert.equal(locks.length, 0, 'verrouillé alors que l\'activité venait de reprendre');
  clock.advance(1000);
  assert.equal(locks.length, 1);
});

test('des activités répétées maintiennent le coffre ouvert', () => {
  const { clock, locks, timer } = build(5000);
  timer.start();
  for (let i = 0; i < 20; i++) {
    clock.advance(4000);
    timer.activity();
  }
  assert.equal(locks.length, 0);
});

test('remaining décroît puis tombe à zéro', () => {
  const { clock, timer } = build(5000);
  assert.equal(timer.remaining(), 5000, 'avant start, le délai complet');
  timer.start();
  clock.jump(2000);
  assert.equal(timer.remaining(), 3000);
  clock.jump(9000);
  assert.equal(timer.remaining(), 0);
});

console.log('\nMinuterie suspendue (téléphone en arrière-plan)');

test('check() verrouille après une veille prolongée', () => {
  const { clock, locks, timer } = build(5000);
  timer.start();
  // L'onglet est mis en veille : le temps passe, aucune minuterie ne tire.
  clock.jump(3600000);
  assert.equal(locks.length, 0, 'aucune minuterie ne devait tirer pendant la veille');
  // Retour au premier plan.
  assert.equal(timer.check(), true);
  assert.equal(locks.length, 1);
});

test('check() ne verrouille pas si le délai n\'est pas écoulé', () => {
  const { clock, locks, timer } = build(5000);
  timer.start();
  clock.jump(2000);
  assert.equal(timer.check(), false);
  assert.equal(locks.length, 0);
});

test('check() replanifie la minuterie', () => {
  const { clock, locks, timer } = build(5000);
  timer.start();
  clock.jump(2000);
  timer.check();
  clock.advance(3000);
  assert.equal(locks.length, 1, 'la minuterie replanifiée aurait dû tirer');
});

console.log('\nArrêt');

test('stop() empêche tout verrouillage', () => {
  const { clock, locks, timer } = build(5000);
  timer.start();
  timer.stop();
  clock.advance(60000);
  assert.equal(locks.length, 0);
});

test('stop() libère la minuterie en attente', () => {
  const { clock, timer } = build(5000);
  timer.start();
  assert.equal(clock.pending(), 1);
  timer.stop();
  assert.equal(clock.pending(), 0);
});

test('activity() est sans effet après stop()', () => {
  const { clock, locks, timer } = build(5000);
  timer.start();
  timer.stop();
  timer.activity();
  clock.advance(60000);
  assert.equal(locks.length, 0);
});

test('check() est sans effet après stop()', () => {
  const { clock, locks, timer } = build(5000);
  timer.start();
  timer.stop();
  clock.jump(60000);
  assert.equal(timer.check(), false);
  assert.equal(locks.length, 0);
});

test('le minuteur est désarmé au moment où onLock s\'exécute', () => {
  // Sinon un onLock qui provoque un rendu, donc une activité, pourrait
  // réarmer un minuteur sur un coffre déjà fermé.
  const clock = fakeClock();
  let armeePendantOnLock = null;
  const timer = createLockTimer({
    timeoutMs: 5000,
    onLock: () => { armeePendantOnLock = timer.isArmed(); },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  timer.start();
  clock.advance(5000);
  assert.equal(armeePendantOnLock, false);
});

test('start() après un verrouillage repart proprement', () => {
  const { clock, locks, timer } = build(5000);
  timer.start();
  clock.advance(5000);
  assert.equal(locks.length, 1);
  timer.start();
  clock.advance(4999);
  assert.equal(locks.length, 1);
  clock.advance(1);
  assert.equal(locks.length, 2);
});

console.log('\n' + ok + ' tests passés.');
