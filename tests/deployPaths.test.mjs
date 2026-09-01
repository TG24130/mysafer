// Tests du déploiement : ce que GitHub Pages servira réellement.
//
// Ces tests ne touchent ni au coffre ni au chiffrement. Ils gardent une seule
// promesse, invisible dans le code et pourtant vitale : chaque fichier que le
// service worker demande doit être servi par le site.
//
// Ils existent à cause d'une panne réelle du 2026-09-01. GitHub Pages passe le
// dépôt par Jekyll, qui ignore silencieusement tout fichier ou dossier préfixé
// d'un tiret bas. Trois fichiers de `js/vendor/noble-hashes/` — `_blake.js`,
// `_md.js`, `_u64.js` — répondaient donc 404 en production alors qu'ils étaient
// bien présents dans le dépôt. Deux conséquences, invisibles jusqu'au jour où
// on est allé regarder :
//
//   1. `cache.addAll()` est atomique. Une seule ressource manquante fait
//      échouer toute l'installation du service worker, qui n'a donc jamais
//      abouti en production : pas de fonctionnement hors ligne, et un ancien
//      cache qui reste actif — de quoi exécuter du code périmé.
//   2. Ces trois fichiers sont importés par le repli Argon2 `@noble/hashes`,
//      le filet prévu si `argon2-browser` échoue. Ce filet n'existait pas.
//
// Rien ne signalait l'écart : le dépôt était complet, les tests au vert, et le
// site fonctionnait. Ce sont ces tests-là qui manquaient.
//
// Lancer :  node tests/deployPaths.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');

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

/** Chemins listés dans CORE_ASSETS de sw.js, débarrassés du './'. */
function coreAssets() {
  const sw = readFileSync(join(racine, 'sw.js'), 'utf8');
  const bloc = sw.slice(sw.indexOf('CORE_ASSETS'), sw.indexOf('];', sw.indexOf('CORE_ASSETS')));
  return [...bloc.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean);
}

/** Tous les fichiers du dépôt, hors dossiers qui ne sont pas déployés. */
function fichiersDeployes(dossier = racine, sortie = []) {
  const ignores = new Set(['node_modules', '.git', 'tests', 'tools']);
  for (const nom of readdirSync(dossier)) {
    if (ignores.has(nom)) continue;
    const chemin = join(dossier, nom);
    if (statSync(chemin).isDirectory()) fichiersDeployes(chemin, sortie);
    else sortie.push(relative(racine, chemin).split(sep).join('/'));
  }
  return sortie;
}

console.log('\nService worker');

test('chaque ressource de CORE_ASSETS existe dans le dépôt', () => {
  const manquants = coreAssets()
    .filter((chemin) => chemin !== '' && !existsSync(join(racine, chemin)));
  assert.deepEqual(manquants, [],
    'fichiers listés mais absents : ' + manquants.join(', '));
});

test('CORE_ASSETS n\'est pas vide', () => {
  assert.ok(coreAssets().length > 5);
});

console.log('\nJekyll');

// La règle : soit aucun fichier ne porte de tiret bas initial, soit `.nojekyll`
// est présent. Le second suffit, et c'est la solution retenue — renommer des
// fichiers de bibliothèque tierce se reperdrait à la prochaine mise à jour.
test('aucun fichier préfixé d\'un tiret bas ne part sans .nojekyll', () => {
  const souligne = fichiersDeployes()
    .filter((chemin) => chemin.split('/').some((seg) => seg.startsWith('_')));

  if (souligne.length === 0) return;   // rien à protéger

  assert.ok(existsSync(join(racine, '.nojekyll')),
    `${souligne.length} fichier(s) préfixé(s) d'un tiret bas seraient ignorés par `
    + 'Jekyll sur GitHub Pages, et répondraient 404 : ' + souligne.join(', ')
    + '. Ajouter un fichier .nojekyll vide à la racine.');
});

console.log(`\n${ok} tests passés.`);
