// Point d'entrée et contrôleur de l'interface.
//
// Répartition des responsabilités :
//   vaultCrypto.js  ouverture/écriture du KDBX, Argon2
//   vaultDb.js      persistance IndexedDB
//   vaultModel.js   lecture du contenu (fonctions pures, testées sous Node)
//   generator.js    génération de secrets
//   app.js          DOM et enchaînement des actions — ce fichier
import { createVault, openVault, saveVault, isWrongPassword, kdbxweb } from './vaultCrypto.js';
import {
  loadVaultBytes, saveVaultBytes, hasVault, getMeta, setMeta, META,
} from './vaultDb.js';
import {
  fieldText, groupName, flattenGroups, entriesOf, allEntries,
  sortByTitle, searchEntries, customFields, urlHost, FIELDS, POSTAL_FIELDS,
} from './vaultModel.js';
import { generatePassphrase, generatePassword, passphraseBits, passwordBits } from './generator.js';
import { createLockTimer, attachActivityListeners, DEFAULT_TIMEOUT_MS } from './lockTimer.js';
import { copySecret, clearNow, cancelPendingClear, onStateChange, stateMessage } from './clipboard.js';
import { rendreReordonnable, rendreReordonnableAuClavier } from './dragOrder.js';
import { signIn, signOutUser, onAuthChange, authState } from './firebaseAuth.js';
import {
  syncNow, downloadRemoteVault, adoptRemoteVault, canSync, syncErrorMessage,
  remplacerDistant, ConflitCoffre,
} from './syncController.js';
import {
  biometrieDisponible, estEnrole, enroler, deverrouiller as deverrouillerBio,
  desactiver as desactiverBio, messageErreur as messageErreurBio,
} from './deviceKey.js';

// Protection anti-cadrage. GitHub Pages ne permet pas de définir l'en-tête
// X-Frame-Options ni frame-ancestors, et `frame-ancestors` est ignoré en
// <meta>. Sortir du cadre est le seul recours côté client.
if (window.top !== window.self) {
  window.top.location = window.self.location;
}

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------

// Instance Kdbx déverrouillée. Vit uniquement en mémoire, jamais persistée.
let db = null;
// UUID du répertoire sélectionné, ou null pour « Tout ».
let selectedGroupUuid = null;
// Entrée ouverte dans le panneau de détail, ou null pour une création.
let editing = null;
let creatingInGroup = null;

// Verrouillage par inactivité. Le minuteur n'est armé que coffre ouvert.
const lockTimer = createLockTimer({
  timeoutMs: DEFAULT_TIMEOUT_MS,
  onLock: () => lockVault('inactivité'),
});
let detachActivity = null;
let countdownHandle = null;

// ---------------------------------------------------------------------------
// Utilitaires DOM
// ---------------------------------------------------------------------------

function setError(msg) {
  $('lock-error').textContent = msg || '';
  $('lock-error').hidden = !msg;
}

function setBusy(on) {
  $('lock-busy').hidden = !on;
  for (const f of [$('form-unlock'), $('form-create'), $('form-signin')]) {
    for (const c of f.elements) c.disabled = on;
  }
}

function showLock() {
  $('screen-lock').hidden = false;
  $('screen-vault').hidden = true;
  closeDetail();
}

function showVault() {
  $('screen-lock').hidden = true;
  $('screen-vault').hidden = false;
  renderGroups();
  renderEntries();
  armLock();
  majRappelExport();
  majBiometrie();
}

/**
 * Ferme le coffre et efface tout ce qui en dérive.
 * Unique chemin de verrouillage : bouton, inactivité, retour d'arrière-plan.
 */
function lockVault(raison) {
  disarmLock();
  // Le presse-papiers peut encore contenir un mot de passe copié juste avant.
  clearNow();

  db = null;
  selectedGroupUuid = null;
  closeDetail();
  $('entry-list').textContent = '';
  $('group-list').textContent = '';
  $('scope-label').textContent = '';
  $('input-search').value = '';

  $('sync-conflict').hidden = true;
  majBioDeverrouillage();
  showLock();
  setError(raison === 'inactivité'
    ? 'Coffre verrouillé après 5 minutes sans activité.'
    : '');
  $('input-master').focus();
}

function armLock() {
  lockTimer.start();
  if (!detachActivity) detachActivity = attachActivityListeners(lockTimer);
  if (countdownHandle === null) countdownHandle = setInterval(renderCountdown, 1000);
  renderCountdown();
}

function disarmLock() {
  lockTimer.stop();
  if (detachActivity) { detachActivity(); detachActivity = null; }
  if (countdownHandle !== null) { clearInterval(countdownHandle); countdownHandle = null; }
  $('lock-countdown').textContent = '';
  $('lock-countdown').classList.remove('is-urgent');
}

/**
 * Affiche le temps restant, mais seulement dans la dernière minute : un
 * compte à rebours permanent est une nuisance, un avertissement tardif est
 * une information.
 */
function renderCountdown() {
  const el = $('lock-countdown');
  if (!lockTimer.isArmed()) { el.textContent = ''; return; }
  const reste = lockTimer.remaining();
  if (reste > 60000) { el.textContent = ''; return; }
  const s = Math.ceil(reste / 1000);
  el.textContent = 'Verrouillage dans ' + s + ' s';
  // Ambre tant que c'est une information ; rouge quand ça devient un
  // avertissement. Jamais orange : l'orange ne dit que « ceci commet ».
  el.classList.toggle('is-urgent', s <= 10);
}

/** Retour visuel bref sur un bouton, sans bloquer l'interface. */
function flash(button, texte) {
  const avant = button.textContent;
  button.textContent = texte;
  setTimeout(() => { button.textContent = avant; }, 1400);
}

async function copyToClipboard(texte, button) {
  if (!texte) return;
  // Ne rien promettre ici sur l'effacement : c'est le module presse-papiers qui
  // dit ce qui s'est réellement produit, via onStateChange ci-dessous.
  flash(button, (await copySecret(texte)) ? 'Copié' : 'Échec');
}

// Filet contre l'échec silencieux. Un gestionnaire `async` qui lève laisse une
// promesse rejetée que personne ne voit : le bouton paraît mort, sans le
// moindre message. C'est exactement ce qui s'est produit sur la suppression par
// balayage — la fonction appelée n'existait pas, et l'utilisateur n'a vu qu'un
// bouton inerte. Sur une application qui garde des mots de passe, un échec muet
// est pire qu'un échec bruyant.
window.addEventListener('unhandledrejection', (e) => {
  const msg = (e.reason && (e.reason.message || String(e.reason))) || 'erreur inconnue';
  if (!$('screen-vault').hidden) setSyncStatus('Échec : ' + msg, 'warn');
  else setError('Échec : ' + msg);
});

// État réel du presse-papiers, affiché sans embellissement. Un effacement qui
// échoue doit se voir : croire un mot de passe effacé alors qu'il ne l'est pas
// est pire que savoir qu'il traîne.
onStateChange((s) => {
  const el = $('clip-status');
  if (!el) return;
  el.textContent = stateMessage(s);
  el.hidden = !el.textContent;
});

// ---------------------------------------------------------------------------
// Persistance
// ---------------------------------------------------------------------------

async function persist() {
  const bytes = await saveVault(db);
  await saveVaultBytes(bytes);
  // La synchronisation part en arrière-plan et n'est jamais attendue : le
  // coffre local est déjà enregistré à cette ligne, l'enregistrement ne doit
  // pas dépendre du réseau.
  syncInBackground();
}

// ---------------------------------------------------------------------------
// Synchronisation
// ---------------------------------------------------------------------------

// Une seule synchronisation à la fois. Sans ce verrou, deux enregistrements
// rapprochés lanceraient deux cycles concurrents sur le même coffre, et le
// second écraserait la référence de fusion posée par le premier.
let syncing = false;
let syncQueued = false;

function setSyncStatus(msg, kind = '') {
  // L'afficheur ne s'éteint jamais : un appareil sans état affiché ressemble à
  // un appareil en panne. Sans message, il retombe sur « Prêt ».
  const el = $('sync-status');
  el.textContent = msg || 'Prêt';
  el.className = 'screenlet-value' + (kind === 'warn' ? ' sync-warn' : '');
}

/**
 * Lance un cycle si c'est possible, sans jamais rejeter.
 * Un échec de synchronisation n'est pas un échec d'enregistrement : le coffre
 * local est intact, on informe et on réessaiera au prochain enregistrement.
 */
async function syncInBackground() {
  if (!db || !canSync()) return;
  if (syncing) { syncQueued = true; return; }

  syncing = true;
  setSyncStatus('Synchronisation…', 'busy');
  try {
    await syncNow(db);
    setSyncStatus('Synchronisé', 'ok');
    // Le coffre a pu changer par la fusion : réafficher plutôt que laisser une
    // liste qui ne correspond plus au contenu réel.
    renderGroups();
    renderEntries();
  } catch (err) {
    if (err instanceof ConflitCoffre) {
      // Rien d'automatique ici : les deux issues détruisent un coffre.
      octetsEnConflit = err.octetsDistants;
      $('sync-conflict').hidden = false;
      setSyncStatus('Synchronisation suspendue', 'warn');
    } else {
      setSyncStatus(syncErrorMessage(err), 'warn');
    }
  } finally {
    syncing = false;
    if (syncQueued) { syncQueued = false; syncInBackground(); }
  }
}

// ---------------------------------------------------------------------------
// Conflit entre deux coffres sans ancêtre commun
// ---------------------------------------------------------------------------

// Octets du coffre distant, retenus le temps que l'utilisateur tranche.
let octetsEnConflit = null;

$('btn-conflict-pull').addEventListener('click', () => {
  if (!confirm(
    "Le coffre de cet appareil sera remplacé par celui en ligne.\n\n"
    + "Son contenu actuel sera perdu s'il n'a pas été exporté. Continuer ?")) return;

  // On repasse par l'écran de déverrouillage : le coffre distant a sa propre
  // phrase maîtresse, et il ne sera installé qu'une fois celle-ci vérifiée.
  pendingRemoteBytes = octetsEnConflit;
  octetsEnConflit = null;
  $('sync-conflict').hidden = true;
  lockVault('conflit');
  refreshLockScreen();
});

$('btn-conflict-push').addEventListener('click', async () => {
  if (!confirm(
    "Le coffre en ligne sera remplacé par celui de cet appareil.\n\n"
    + "Une copie de ce qui est écrasé restera dans l'historique en ligne. Continuer ?")) return;

  setSyncStatus('Remplacement…', 'busy');
  try {
    await remplacerDistant(db);
    octetsEnConflit = null;
    $('sync-conflict').hidden = true;
    setSyncStatus('Synchronisé', 'ok');
  } catch (err) {
    setSyncStatus(syncErrorMessage(err), 'warn');
  }
});

// ---------------------------------------------------------------------------
// Répertoires
// ---------------------------------------------------------------------------

function groupByUuid(uuid) {
  const found = flattenGroups(db).find((g) => g.uuid === uuid);
  return found ? found.group : null;
}

/** Répertoire courant, ou le répertoire par défaut si « Tout » est actif. */
function currentGroup() {
  return (selectedGroupUuid && groupByUuid(selectedGroupUuid)) || db.getDefaultGroup();
}

function renderGroups() {
  const list = $('group-list');
  list.textContent = '';

  const total = allEntries(db).length;
  list.append(groupItem({ uuid: null, name: 'Tout', depth: 0, entryCount: total }));

  for (const g of flattenGroups(db)) {
    list.append(groupItem({
      uuid: g.uuid,
      name: g.name,
      depth: g.depth,
      parentUuid: g.group.parentGroup ? String(g.group.parentGroup.uuid) : '',
      // La racine n'a pas de parent : c'est le coffre, pas un répertoire.
      supprimable: Boolean(g.group.parentGroup),
      // Le compte affiché inclut les sous-répertoires : c'est ce que
      // l'utilisateur voit en cliquant dessus.
      entryCount: entriesOf(g.group).length,
    }));
  }
}

/**
 * Supprime un répertoire, après confirmation qui annonce ce qu'il emporte.
 *
 * Le compte est récursif : un répertoire supprimé emmène ses sous-répertoires
 * et toutes leurs entrées. Ne pas le dire reviendrait à faire disparaître des
 * mots de passe sur un geste qui n'annonçait qu'un rangement.
 */
async function supprimerGroupe(groupe) {
  if (!groupe || !groupe.parentGroup) return false;   // jamais la racine

  const nom = groupName(groupe);
  const combien = entriesOf(groupe).length;
  const detail = combien === 0
    ? 'Il est vide.'
    : `Il contient ${combien} entrée${combien > 1 ? 's' : ''}, qui partiront avec lui.`;

  if (!confirm(`Supprimer le répertoire « ${nom} » ?\n\n${detail}\n\n`
    + "Tout part à la corbeille du coffre : rien n'est effacé définitivement, "
    + 'et KeePassXC permet de le récupérer.')) return false;

  db.remove(groupe);
  // Si c'était le répertoire affiché, revenir à « Tout » plutôt que de rester
  // sur une sélection qui n'existe plus.
  if (selectedGroupUuid === String(groupe.uuid)) selectedGroupUuid = null;

  await persist();
  renderGroups();
  renderEntries();
  return true;
}

function groupItem({ uuid, name, depth, entryCount, parentUuid, supprimable }) {
  const li = document.createElement('li');
  li.className = 'group-row';
  // L'entrée « Tout » n'est pas un répertoire : elle ne se déplace pas, et rien
  // ne peut se ranger à sa place.
  if (uuid) {
    li.dataset.uuid = uuid;
    li.dataset.parent = parentUuid || '';
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'group-btn';
  // Indentation par unité de touche, posée via la CSSOM : la CSP interdit
  // les attributs style dans le HTML, pas la manipulation depuis le script.
  btn.style.paddingLeft = (16 + depth * 16) + 'px';
  if (uuid === selectedGroupUuid) btn.setAttribute('aria-current', 'true');

  const label = document.createElement('span');
  label.className = 'group-name';
  label.textContent = name;

  const count = document.createElement('span');
  count.className = 'group-count';
  count.textContent = String(entryCount);

  btn.append(label, count);
  btn.addEventListener('click', () => {
    // Une ligne ouverte se referme au lieu de changer de répertoire.
    if (li.classList.contains('is-open')) { fermerLigne(); return; }
    selectedGroupUuid = uuid;
    renderGroups();
    renderEntries();
    closeGroupPanel();
  });

  // « Tout » et la racine ne se suppriment pas : l'une n'est pas un
  // répertoire, l'autre est le coffre lui-même.
  if (!supprimable) {
    li.append(btn);
    return li;
  }

  const logement = document.createElement('div');
  logement.className = 'swipe-slot';
  const supprimer = document.createElement('button');
  supprimer.type = 'button';
  supprimer.className = 'key key-danger swipe-remove';
  supprimer.textContent = 'Supprimer';
  supprimer.tabIndex = -1;
  supprimer.setAttribute('aria-hidden', 'true');
  supprimer.addEventListener('click', async () => {
    if (!(await supprimerGroupe(groupeParUuid(uuid)))) fermerLigne();
  });
  logement.append(supprimer);

  const slide = document.createElement('div');
  slide.className = 'swipe-slide';
  slide.append(btn);
  rendreBalayable(li, slide);

  // Équivalent clavier : le balayage est inaccessible sans écran tactile, et
  // les répertoires n'ont pas de panneau de détail où loger un bouton.
  btn.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete') return;
    e.preventDefault();
    supprimerGroupe(groupeParUuid(uuid));
  });

  li.append(logement, slide);
  return li;
}

/**
 * Bascule la vue courante.
 *
 * Sur téléphone, une seule vue est montée à la fois et la barre de modes du bas
 * commande — c'est la rangée de touches de mode de l'appareil, placée sous le
 * pouce parce que l'usage de référence est le téléphone tenu d'une main. Au-delà
 * de 900 px la feuille de style montre les trois vues côte à côte et masque la
 * barre : la fonction devient alors sans effet visible, ce qui est voulu.
 */
function showView(nom) {
  for (const vue of document.querySelectorAll('.view')) {
    vue.classList.toggle('is-current', vue.dataset.view === nom);
  }
  for (const onglet of document.querySelectorAll('.tab')) {
    const actif = onglet.dataset.target === nom;
    onglet.classList.toggle('is-current', actif);
    if (actif) onglet.setAttribute('aria-current', 'page');
    else onglet.removeAttribute('aria-current');
  }
}

/** Choisir un répertoire ramène à la liste : c'est ce qu'on venait y chercher. */
function closeGroupPanel() {
  showView('entries');
}

// ---------------------------------------------------------------------------
// Liste des entrées
// ---------------------------------------------------------------------------

function visibleRows() {
  const base = selectedGroupUuid
    ? entriesOf(groupByUuid(selectedGroupUuid) || db.getDefaultGroup())
    : allEntries(db);
  // Ordre du fichier, et non ordre alphabétique : c'est l'utilisateur qui
  // range, par appui long puis déplacement. Trier ici annulerait chaque dépôt
  // à la seconde suivante.
  // Pendant une recherche, en revanche, l'ordre manuel n'a plus de sens sur un
  // sous-ensemble : on trie, et le déplacement est désactivé.
  const q = $('input-search').value.trim();
  const rows = searchEntries(base, q);
  return q ? sortByTitle(rows) : rows;
}

/** Vrai quand une recherche filtre la liste : réordonner y serait trompeur. */
function rechercheActive() {
  return $('input-search').value.trim() !== '';
}

function renderEntries() {
  ligneOuverte = null;
  const rows = visibleRows();
  const list = $('entry-list');
  list.textContent = '';

  const scope = selectedGroupUuid
    ? groupName(groupByUuid(selectedGroupUuid) || db.getDefaultGroup())
    : 'Toutes les entrées';
  $('scope-label').textContent = scope + ' · ' + rows.length
    + (rows.length > 1 ? ' entrées' : ' entrée');

  for (const { entry, group } of rows) list.append(entryItem(entry, group));
  $('entry-empty').hidden = rows.length > 0;
}

// Distance de révélation, en pixels : la largeur de la touche découverte.
const REVELATION = 108;

// Une seule ligne ouverte à la fois. Deux touches rouges visibles ensemble,
// c'est une suppression de trop tôt ou tard.
let ligneOuverte = null;

function fermerLigne() {
  if (!ligneOuverte) return;
  ligneOuverte.classList.remove('is-open');
  ligneOuverte.style.removeProperty('--glisse');
  ligneOuverte = null;
}

/**
 * Rend une ligne balayable vers la gauche.
 *
 * Le suivi ne se verrouille en horizontal qu'après un déplacement franc et
 * majoritairement latéral : sans cette condition, un pouce qui fait défiler la
 * liste ouvrirait des lignes au passage. Tant que le verrou n'est pas pris, le
 * défilement vertical reste au navigateur.
 */
function rendreBalayable(li, slide) {
  let x0 = 0;
  let y0 = 0;
  let axe = null;        // null tant qu'on ne sait pas, puis 'x' ou 'y'
  let dx = 0;

  slide.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    if (ligneOuverte && ligneOuverte !== li) fermerLigne();
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
    axe = null;
    dx = 0;
  }, { passive: true });

  slide.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return;
    const ex = e.touches[0].clientX - x0;
    const ey = e.touches[0].clientY - y0;

    if (axe === null) {
      if (Math.abs(ex) < 12 && Math.abs(ey) < 12) return;
      axe = Math.abs(ex) > Math.abs(ey) ? 'x' : 'y';
    }
    if (axe !== 'x') return;

    const base = li.classList.contains('is-open') ? -REVELATION : 0;
    dx = Math.max(-REVELATION, Math.min(0, base + ex));
    li.style.setProperty('--glisse', dx + 'px');
  }, { passive: true });

  const relacher = () => {
    if (axe !== 'x') { axe = null; return; }
    axe = null;
    const ouvrir = dx < -REVELATION / 2;
    li.style.removeProperty('--glisse');
    li.classList.toggle('is-open', ouvrir);
    ligneOuverte = ouvrir ? li : (ligneOuverte === li ? null : ligneOuverte);
  };

  slide.addEventListener('touchend', relacher, { passive: true });
  slide.addEventListener('touchcancel', relacher, { passive: true });
}

function entryItem(entry, group) {
  const li = document.createElement('li');
  li.className = 'entry';
  li.dataset.uuid = String(entry.uuid);

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'entry-main';

  const title = document.createElement('span');
  title.className = 'entry-title';
  title.textContent = fieldText(entry, 'Title') || '(sans titre)';

  const sub = document.createElement('span');
  sub.className = 'entry-sub';
  const bits = [fieldText(entry, 'UserName'), urlHost(fieldText(entry, 'URL')), groupName(group)]
    .filter(Boolean);
  sub.textContent = bits.join(' · ');

  open.append(title, sub);
  open.addEventListener('click', () => {
    // Une ligne ouverte se referme au lieu d'ouvrir la fiche : sinon le geste
    // suivant après un balayage tombe sur un écran qu'on n'a pas demandé.
    if (li.classList.contains('is-open')) { fermerLigne(); return; }
    openDetail(entry, group);
  });

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'key key-action key-copy';
  copy.textContent = 'Copier';
  copy.addEventListener('click', () => copyToClipboard(fieldText(entry, 'Password'), copy));

  // Logement : la touche rouge attend sous le capuchon, découverte par le
  // balayage. Elle double le bouton du panneau de détail, qui reste le chemin
  // accessible au clavier ; d'où aria-hidden, pour ne pas annoncer deux fois
  // la même action ni piéger le focus sur un élément hors écran.
  const logement = document.createElement('div');
  logement.className = 'swipe-slot';
  const supprimer = document.createElement('button');
  supprimer.type = 'button';
  supprimer.className = 'key key-danger swipe-remove';
  supprimer.textContent = 'Supprimer';
  supprimer.tabIndex = -1;
  supprimer.setAttribute('aria-hidden', 'true');
  supprimer.addEventListener('click', async () => {
    if (!(await demanderSuppression(entry))) fermerLigne();
  });
  logement.append(supprimer);

  const slide = document.createElement('div');
  slide.className = 'swipe-slide';
  slide.append(open, copy);
  rendreBalayable(li, slide);

  li.append(logement, slide);
  return li;
}

// ---------------------------------------------------------------------------
// Réordonnancement au doigt
// ---------------------------------------------------------------------------
//
// KDBX conserve l'ordre des entrées et des répertoires dans le fichier lui-même,
// et kdbxweb expose `db.move(objet, groupe, index)` — le même appel sert aux
// deux. L'ordre choisi ici survit donc à l'export et se retrouve dans
// KeePassXC.

/** Retrouve un objet du coffre à partir de l'uuid porté par sa ligne. */
function entreeParUuid(uuid) {
  const trouve = allEntries(db).find((r) => String(r.entry.uuid) === uuid);
  return trouve || null;
}

function groupeParUuid(uuid) {
  const trouve = flattenGroups(db).find((g) => g.uuid === uuid);
  return trouve ? trouve.group : null;
}

/**
 * Applique à la base l'ordre que le DOM vient d'adopter.
 *
 * On relit la liste plutôt que de se fier à l'index annoncé : le déplacement a
 * pu franchir plusieurs voisins, et le DOM est la seule vérité sur le résultat.
 */
async function appliquerOrdreEntrees() {
  const lignes = [...$('entry-list').querySelectorAll('.entry[data-uuid]')];
  for (let i = 0; i < lignes.length; i += 1) {
    const trouve = entreeParUuid(lignes[i].dataset.uuid);
    if (!trouve) continue;
    // Déposer une entrée parmi celles d'un autre répertoire l'y range : c'est
    // ce que le geste laisse attendre, et le refuser serait déroutant.
    const cible = trouve.group;
    db.move(trouve.entry, cible, i);
  }
  await persist();
  renderGroups();
  renderEntries();
}

async function appliquerOrdreGroupes() {
  const lignes = [...$('group-list').querySelectorAll('.group-row[data-uuid]')];
  for (let i = 0; i < lignes.length; i += 1) {
    const groupe = groupeParUuid(lignes[i].dataset.uuid);
    if (!groupe || !groupe.parentGroup) continue;
    // Index parmi ses seuls frères : la liste est aplatie, mais l'arbre ne
    // l'est pas.
    const freres = lignes.filter((l) => l.dataset.parent === lignes[i].dataset.parent);
    db.move(groupe, groupe.parentGroup, freres.indexOf(lignes[i]));
  }
  await persist();
  renderGroups();
  renderEntries();
}

/** Un répertoire ne peut se ranger qu'entre ses propres frères. */
const freresDe = (li) => [...$('group-list').querySelectorAll('.group-row[data-uuid]')]
  .filter((autre) => autre.dataset.parent === li.dataset.parent);

const optionsEntrees = {
  liste: $('entry-list'),
  selecteur: '.entry[data-uuid]',
  deplacable: () => !rechercheActive(),
  surDepot: () => { appliquerOrdreEntrees(); },
};

const optionsGroupes = {
  liste: $('group-list'),
  selecteur: '.group-row[data-uuid]',
  voisinsPossibles: freresDe,
  surDepot: () => { appliquerOrdreGroupes(); },
};

rendreReordonnable(optionsEntrees);
rendreReordonnableAuClavier(optionsEntrees);
rendreReordonnable(optionsGroupes);
rendreReordonnableAuClavier(optionsGroupes);

// ---------------------------------------------------------------------------
// Panneau de détail
// ---------------------------------------------------------------------------

function fillGroupSelect(selectedUuid) {
  const sel = $('d-group');
  sel.textContent = '';
  for (const g of flattenGroups(db)) {
    const opt = document.createElement('option');
    opt.value = g.uuid;
    opt.textContent = ' '.repeat(g.depth * 2) + g.name;
    if (g.uuid === selectedUuid) opt.selected = true;
    sel.append(opt);
  }
}

function setReveal(on) {
  $('d-password').type = on ? 'text' : 'password';
  $('btn-reveal').textContent = on ? 'Masquer' : 'Afficher';
  $('btn-reveal').setAttribute('aria-pressed', String(on));
}

function updateStrength() {
  const v = $('d-password').value;
  const el = $('gen-strength');
  if (!v) { el.textContent = ''; return; }
  // Estimation volontairement grossière : l'alphabet est déduit de ce qui est
  // présent. Un vrai score (zxcvbn) viendra plus tard ; ici il s'agit
  // seulement de ne pas laisser l'utilisateur sans repère.
  let alphabet = 0;
  if (/[a-z]/.test(v)) alphabet += 26;
  if (/[A-Z]/.test(v)) alphabet += 26;
  if (/[0-9]/.test(v)) alphabet += 10;
  if (/[^a-zA-Z0-9]/.test(v)) alphabet += 20;
  el.textContent = '≈ ' + Math.round(passwordBits(v.length, alphabet || 1)) + ' bits';
}

// Les trois champs postaux sont des champs personnalisés KDBX. La table est
// définie une fois : ajouter un champ ici suffit, ouverture et enregistrement
// suivent.
const CHAMPS_POSTAUX = [
  ['Adresse', 'd-street'],
  ['Code postal', 'd-zip'],
  ['Ville', 'd-city'],
];

function openDetail(entry, group) {
  editing = entry;
  creatingInGroup = null;
  $('detail-title').textContent = 'Modifier l\'entrée';
  $('btn-delete').hidden = false;

  $('d-title').value = fieldText(entry, 'Title');
  $('d-username').value = fieldText(entry, 'UserName');
  $('d-password').value = fieldText(entry, 'Password');
  $('d-url').value = fieldText(entry, 'URL');
  for (const [champ, id] of CHAMPS_POSTAUX) $(id).value = fieldText(entry, champ);
  $('d-notes').value = fieldText(entry, 'Notes');
  fillGroupSelect(String(group.uuid));

  // Les champs personnalisés du format KDBX sont affichés en lecture seule :
  // ne pas les montrer donnerait l'impression qu'ils ont été perdus.
  const box = $('d-custom');
  box.textContent = '';
  const extras = customFields(entry);
  box.hidden = extras.length === 0;
  if (extras.length) {
    const h = document.createElement('h3');
    h.className = 'custom-title';
    h.textContent = 'Champs personnalisés';
    box.append(h);
    for (const { key, value } of extras) {
      const p = document.createElement('p');
      p.className = 'custom-field';
      const k = document.createElement('strong');
      k.textContent = key + ' : ';
      p.append(k, document.createTextNode(value));
      box.append(p);
    }
  }

  setReveal(false);
  updateStrength();
  $('detail').hidden = false;
  $('d-title').focus();
}

function openNewEntry() {
  editing = null;
  creatingInGroup = currentGroup();
  $('detail-title').textContent = 'Nouvelle entrée';
  $('btn-delete').hidden = true;

  for (const id of ['d-title', 'd-username', 'd-password', 'd-url', 'd-notes',
    ...CHAMPS_POSTAUX.map(([, id2]) => id2)]) $(id).value = '';
  fillGroupSelect(String(creatingInGroup.uuid));
  $('d-custom').hidden = true;
  $('d-custom').textContent = '';

  setReveal(false);
  updateStrength();
  $('detail').hidden = false;
  $('d-title').focus();
}

function closeDetail() {
  $('detail').hidden = true;
  editing = null;
  creatingInGroup = null;
  // Ne pas laisser un mot de passe en clair dans le DOM après fermeture.
  for (const id of ['d-title', 'd-username', 'd-password', 'd-url', 'd-notes',
    ...CHAMPS_POSTAUX.map(([, id2]) => id2)]) {
    const el = $(id);
    if (el) el.value = '';
  }
  setReveal(false);
}

async function saveDetail(e) {
  e.preventDefault();

  const cible = groupByUuid($('d-group').value) || db.getDefaultGroup();
  let entry = editing;

  if (!entry) {
    entry = db.createEntry(cible);
  } else {
    // Historique KDBX : conserve l'état précédent de l'entrée. C'est aussi ce
    // qui permet à la fusion multi-appareils (phase 4) de trancher proprement.
    entry.pushHistory();
    const actuel = flattenGroups(db).find((g) => g.group.entries.includes(entry));
    if (actuel && actuel.uuid !== String(cible.uuid)) db.move(entry, cible);
  }

  entry.fields.set('Title', $('d-title').value);
  entry.fields.set('UserName', $('d-username').value);
  entry.fields.set('URL', $('d-url').value);
  entry.fields.set('Notes', $('d-notes').value);

  // Un champ postal vide est retiré plutôt qu'enregistré à blanc : sinon
  // chaque fiche traînerait trois champs personnalisés vides, visibles comme
  // tels dans KeePassXC.
  for (const [champ, id] of CHAMPS_POSTAUX) {
    const valeur = $(id).value.trim();
    if (valeur) entry.fields.set(champ, valeur);
    else entry.fields.delete(champ);
  }
  // Le mot de passe est stocké en ProtectedValue : chiffré en mémoire par
  // kdbxweb et marqué « protégé » dans le fichier KDBX.
  entry.fields.set('Password', kdbxweb.ProtectedValue.fromString($('d-password').value));
  entry.times.update();

  await persist();
  closeDetail();
  renderGroups();
  renderEntries();
}

/**
 * Supprime une entrée, après confirmation explicite.
 *
 * Chemin unique, appelé par le bouton du panneau de détail et par le balayage
 * de la liste. La confirmation n'est pas négociable : sur téléphone, un
 * balayage part parfois d'un pouce qui voulait faire défiler.
 *
 * @returns {Promise<boolean>} true si la suppression a eu lieu.
 */
async function demanderSuppression(entry) {
  if (!entry) return false;
  const titre = fieldText(entry, 'Title') || '(sans titre)';
  if (!confirm('Supprimer « ' + titre + ' » ?\n\n'
    + "L'entrée part à la corbeille du coffre : elle reste récupérable dans "
    + 'KeePassXC, et la copie horodatée en ligne la conserve aussi.')) return false;

  db.remove(entry);
  await persist();
  renderGroups();
  renderEntries();
  return true;
}

async function deleteEntry() {
  if (await demanderSuppression(editing)) closeDetail();
}

// ---------------------------------------------------------------------------
// Actions de l'écran de verrouillage
// ---------------------------------------------------------------------------

$('btn-gen-master').addEventListener('click', async (e) => {
  try {
    const phrase = await generatePassphrase(6);
    const out = $('gen-master-out');
    out.hidden = false;
    out.textContent = phrase;
    $('gen-master-hint').hidden = false;
    $('input-new-master').value = phrase;
    $('input-new-master2').value = '';
    $('input-new-master2').focus();
  } catch (err) {
    setError('Génération impossible : ' + (err && err.message ? err.message : String(err)));
  }
});

$('form-create').addEventListener('submit', async (e) => {
  e.preventDefault();
  setError('');
  const pwd = $('input-new-master').value;
  if (pwd !== $('input-new-master2').value) {
    setError('Les deux saisies ne correspondent pas.');
    return;
  }
  setBusy(true);
  try {
    db = createVault(pwd, 'Coffre');
    // Un enrôlement biométrique laissé par un coffre précédent emballerait une
    // phrase qui n'ouvre plus rien.
    await desactiverBio();
    await persist();
    $('input-new-master').value = $('input-new-master2').value = '';
    $('gen-master-out').textContent = '';
    $('gen-master-out').hidden = true;
    $('gen-master-hint').hidden = true;
    showVault();
  } catch (err) {
    setError('Création impossible : ' + (err && err.message ? err.message : String(err)));
  } finally {
    setBusy(false);
  }
});

$('input-master').addEventListener('input', () => setError(''));

$('form-unlock').addEventListener('submit', async (e) => {
  e.preventDefault();
  setError('');
  setBusy(true);
  try {
    // Appareil neuf : le coffre vient d'être téléchargé et n'est pas encore
    // installé. On ne l'écrit dans IndexedDB qu'une fois la phrase vérifiée,
    // pour ne jamais stocker un fichier qu'on ne saurait pas rouvrir.
    if (pendingRemoteBytes) {
      db = await adoptRemoteVault(pendingRemoteBytes, $('input-master').value);
      // Le coffre local vient d'être remplacé par un autre, avec sa propre
      // phrase maîtresse. L'enrôlement biométrique emballait l'ancienne : le
      // garder produirait un déverrouillage qui échoue sans raison lisible.
      // On le retire, l'utilisateur le refera en connaissance de cause.
      await desactiverBio();
    } else {
      db = await openVault(await loadVaultBytes(), $('input-master').value);
    }
    pendingRemoteBytes = null;
    $('input-master').value = '';
    selectedGroupUuid = null;
    $('input-search').value = '';
    showVault();
    syncInBackground();
  } catch (err) {
    setError(isWrongPassword(err)
      ? 'Phrase de passe maître incorrecte.'
      : 'Ouverture impossible : ' + (err && err.message ? err.message : String(err)));
  } finally {
    setBusy(false);
  }
});

// ---------------------------------------------------------------------------
// Actions du coffre
// ---------------------------------------------------------------------------

for (const onglet of document.querySelectorAll('.tab')) {
  onglet.addEventListener('click', () => showView(onglet.dataset.target));
}

$('btn-add-group').addEventListener('click', async () => {
  const nom = prompt('Nom du nouveau répertoire ?');
  if (!nom || !nom.trim()) return;
  db.createGroup(currentGroup(), nom.trim());
  await persist();
  renderGroups();
});

$('btn-add').addEventListener('click', openNewEntry);
$('input-search').addEventListener('input', renderEntries);

$('btn-lock').addEventListener('click', () => lockVault('manuel'));

// Export du .kdbx. Sert aussi de vérification : le fichier doit s'ouvrir dans
// KeePassXC sans erreur.
$('btn-export').addEventListener('click', async () => {
  const bytes = await saveVault(db);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'coffre-' + new Date().toISOString().slice(0, 10) + '.kdbx';
  a.click();
  URL.revokeObjectURL(url);

  // On enregistre la date sans savoir si le fichier a réellement été écrit :
  // aucune API ne le dit, et le rappel n'a pas à être plus rigoureux que ça.
  // Se tromper d'un rappel est sans conséquence ; harceler l'utilisateur en
  // aurait une, il finirait par ne plus le lire.
  await setMeta(META.LAST_EXPORT, Date.now());
  majRappelExport();
});

// ---------------------------------------------------------------------------
// Rappel d'export local
// ---------------------------------------------------------------------------

// Pourquoi ce rappel existe alors que les copies horodatées sont en place :
// elles vivent toutes chez le même hébergeur, sous le même compte. Un compte
// fermé, une erreur de facturation ou une suppression malencontreuse les
// emporterait ensemble. Un fichier sur votre disque est la seule copie qui ne
// dépende de personne.
const DELAI_RAPPEL_EXPORT = 30 * 24 * 3600 * 1000;   // 30 jours

async function majRappelExport() {
  const el = $('export-reminder');
  if (!el) return;

  const dernier = await getMeta(META.LAST_EXPORT);
  const jamais = !dernier;
  const ancien = !jamais && (Date.now() - dernier) > DELAI_RAPPEL_EXPORT;

  if (!jamais && !ancien) {
    const jours = Math.round((Date.now() - dernier) / 86400000);
    el.textContent = jours === 0
      ? 'Copie sur disque exportée aujourd’hui.'
      : `Dernière copie sur disque il y a ${jours} jour${jours > 1 ? 's' : ''}.`;
    el.className = 'readout';
    el.hidden = false;
    return;
  }

  el.textContent = jamais
    ? 'Aucune copie sur disque. Les sauvegardes en ligne dépendent toutes du même compte : exportez le fichier au moins une fois.'
    : 'Dernière copie sur disque il y a plus de 30 jours.';
  el.className = 'readout readout-alert';
  el.hidden = false;
}

// --- Détail -----------------------------------------------------------------

$('form-detail').addEventListener('submit', saveDetail);
$('btn-detail-close').addEventListener('click', closeDetail);
$('btn-delete').addEventListener('click', deleteEntry);
$('btn-reveal').addEventListener('click', () => setReveal($('d-password').type === 'password'));
$('d-password').addEventListener('input', updateStrength);

$('btn-copy-user').addEventListener('click', (e) =>
  copyToClipboard($('d-username').value, e.currentTarget));
$('btn-copy-pwd').addEventListener('click', (e) =>
  copyToClipboard($('d-password').value, e.currentTarget));

$('btn-gen-phrase').addEventListener('click', async (e) => {
  try {
    $('d-password').value = await generatePassphrase(6);
    setReveal(true);
    $('gen-strength').textContent = '≈ ' + Math.round(passphraseBits(6)) + ' bits';
  } catch (err) {
    flash(e.currentTarget, 'Échec');
  }
});

$('btn-gen-pwd').addEventListener('click', () => {
  $('d-password').value = generatePassword(20);
  setReveal(true);
  updateStrength();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('detail').hidden) closeDetail();
});

// Fermeture de l'onglet : dernière chance d'effacer le presse-papiers. Le
// navigateur ne garantit pas l'exécution d'une écriture asynchrone ici, d'où
// l'annulation de la purge programmée qui, elle, ne servira plus à rien.
// Fermeture de l'onglet : tenter un dernier effacement sans armer de
// déclencheur au geste — il n'y aura plus de geste.
window.addEventListener('pagehide', () => { clearNow(false); cancelPendingClear(); });

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

// Coffre téléchargé depuis le cloud mais pas encore installé : il attend que
// la phrase de passe maître le valide. Null le reste du temps.
let pendingRemoteBytes = null;

/**
 * Décide quel formulaire montrer sur l'écran de verrouillage.
 *
 * Trois situations :
 *   coffre local présent            → déverrouiller
 *   pas de coffre local, mais un    → déverrouiller, en signalant qu'il vient
 *     coffre en ligne récupéré        d'être récupéré
 *   ni l'un ni l'autre              → créer
 */
async function refreshLockScreen() {
  const exists = await hasVault();

  if (!exists && !pendingRemoteBytes && canSync()) {
    setSyncStatus('Recherche du coffre en ligne…', 'busy');
    try {
      pendingRemoteBytes = await downloadRemoteVault();
      setSyncStatus('');
      if (!pendingRemoteBytes) {
        $('account-state').textContent =
          `Connecté : ${authState.currentUser.email} — aucun coffre en ligne pour ce compte.`;
      }
    } catch (err) {
      // Ne pas avaler l'erreur : sans message, un téléchargement en panne est
      // indiscernable d'un compte sans coffre, et on proposerait d'en créer un
      // second au lieu de récupérer l'existant.
      pendingRemoteBytes = null;
      setError('Coffre en ligne inaccessible : ' + syncErrorMessage(err));
      $('account-state').textContent =
        `Connecté : ${authState.currentUser.email} — récupération impossible.`;
    }
  }

  const déverrouiller = exists || Boolean(pendingRemoteBytes);
  $('form-unlock').hidden = !déverrouiller;
  $('form-create').hidden = déverrouiller;
  $('unlock-sub').textContent = pendingRemoteBytes
    ? 'Coffre récupéré en ligne. Saisissez votre phrase de passe maître pour l’installer sur cet appareil.'
    : 'Saisissez votre phrase de passe maître.';

  majBioDeverrouillage();

  // Appareil neuf et non connecté : on remonte le bloc Synchronisation avant la
  // création, et on ouvre le formulaire de connexion. Créer un coffre ici est
  // presque toujours une erreur — deux coffres sans ancêtre commun ne
  // fusionnent pas — et l'ordre inverse l'a effectivement provoquée deux fois.
  const accueil = !déverrouiller && !authState.currentUser;
  document.querySelector('.lock-card').classList.toggle('lock-card-accueil', accueil);
  $('create-hint').hidden = !accueil;
  if (accueil && authState.resolved) {
    $('form-signin').hidden = false;
    $('btn-signin-toggle').hidden = true;
  }

  if (!$('screen-lock').hidden) {
    if (accueil) $('input-email').focus();
    else (déverrouiller ? $('input-master') : $('input-new-master')).focus();
  }
}

// ---------------------------------------------------------------------------
// Ouverture biométrique
// ---------------------------------------------------------------------------

function setBioErreur(msg) {
  $('bio-error').textContent = msg || '';
  $('bio-error').hidden = !msg;
}

/** Écran de verrouillage : proposer le raccourci si cet appareil est enrôlé. */
async function majBioDeverrouillage() {
  const dispo = (await estEnrole()) && (await biometrieDisponible());
  $('btn-bio-unlock').hidden = !dispo;
  $('bio-sep').hidden = !dispo;
}

/** Panneau du coffre : état de l'enrôlement et action correspondante. */
async function majBiometrie() {
  const box = $('bio-box');
  if (!(await biometrieDisponible())) {
    // Ni option ni explication : afficher une fonction impossible n'aiderait
    // personne. Le diagnostic, lui, dit pourquoi.
    box.hidden = true;
    return;
  }
  box.hidden = false;
  setBioErreur('');

  const enrole = await estEnrole();
  $('bio-state').textContent = enrole
    ? 'Activée sur cet appareil. Le déverrouillage par phrase maîtresse reste toujours possible.'
    : 'Déverrouillez par empreinte, visage ou code d’appareil, sans ressaisir la phrase. L’enrôlement ne vaut que pour cet appareil et ce navigateur.';
  $('form-bio-enrol').hidden = enrole;
  $('btn-bio-disable').hidden = !enrole;
  $('input-bio-master').value = '';
}

$('btn-bio-unlock').addEventListener('click', async () => {
  setError('');
  setBusy(true);
  try {
    const phrase = await deverrouillerBio();
    db = await openVault(await loadVaultBytes(), phrase);
    selectedGroupUuid = null;
    $('input-search').value = '';
    showVault();
    syncInBackground();
  } catch (err) {
    // Le chemin par la phrase maîtresse reste sous les yeux : un échec ici
    // n'enferme personne dehors.
    setError(messageErreurBio(err));
    $('input-master').focus();
  } finally {
    setBusy(false);
  }
});

$('form-bio-enrol').addEventListener('submit', async (e) => {
  e.preventDefault();
  setBioErreur('');
  const phrase = $('input-bio-master').value;

  // On revérifie la phrase contre le coffre enregistré plutôt que de garder
  // celle de l'ouverture en mémoire. Deux raisons : aucune phrase en clair ne
  // traîne pendant la session, et on ne peut pas enrôler une phrase erronée,
  // ce qui produirait un déverrouillage biométrique définitivement inopérant.
  try {
    await openVault(await loadVaultBytes(), phrase);
  } catch (err) {
    setBioErreur(isWrongPassword(err)
      ? 'Phrase de passe maître incorrecte.'
      : 'Vérification impossible : ' + (err && err.message ? err.message : String(err)));
    return;
  }

  try {
    await enroler(phrase);
    $('input-bio-master').value = '';
    await majBiometrie();
  } catch (err) {
    setBioErreur(messageErreurBio(err));
  }
});

$('btn-bio-disable').addEventListener('click', async () => {
  if (!confirm(
    "L'ouverture biométrique sera désactivée sur cet appareil.\n\n"
    + 'Le coffre restera accessible par la phrase maîtresse. Continuer ?')) return;
  await desactiverBio();
  await majBiometrie();
  setBioErreur('');
});

// ---------------------------------------------------------------------------
// Compte de synchronisation
// ---------------------------------------------------------------------------

function refreshAccountUi() {
  const user = authState.currentUser;
  const connecté = Boolean(user);

  $('account-state').textContent = connecté
    ? `Connecté : ${user.email}`
    : (authState.resolved ? 'Non connecté. Le coffre fonctionne sans compte.' : 'Vérification du compte…');

  $('btn-signout').hidden = !connecté;
  if (connecté) $('form-signin').hidden = true;
  // Le bouton d'ouverture disparaît dès que le formulaire est là : deux
  // « Se connecter » empilés ne servent à rien et brouillent le geste.
  $('btn-signin-toggle').hidden = connecté || !$('form-signin').hidden;
}

$('btn-signin-toggle').addEventListener('click', () => {
  $('form-signin').hidden = false;
  $('btn-signin-toggle').hidden = true;
  $('input-email').focus();
});

$('form-signin').addEventListener('submit', async (e) => {
  e.preventDefault();
  setError('');
  setBusy(true);
  try {
    await signIn($('input-email').value, $('input-account-password').value);
    $('input-account-password').value = '';
    $('form-signin').hidden = true;
  } catch (err) {
    // Firebase distingue mot de passe faux, compte inconnu et trop d'essais ;
    // pour l'utilisateur c'est le même geste, et détailler renseignerait un
    // tiers sur l'existence du compte.
    setError(err && err.code === 'auth/network-request-failed'
      ? 'Pas de réseau : connexion impossible.'
      : 'Connexion refusée. Vérifiez l’adresse et le mot de passe du compte.');
  } finally {
    setBusy(false);
  }
});

$('btn-signout').addEventListener('click', async () => {
  await signOutUser();
  // Le coffre local reste en place : se déconnecter arrête la synchronisation,
  // ça n'efface rien.
  setSyncStatus('');
});

onAuthChange(() => {
  refreshAccountUi();
  if (!$('screen-lock').hidden) refreshLockScreen();
  else syncInBackground();
});

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

(async function start() {
  refreshAccountUi();
  await refreshLockScreen();
  showLock();
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
