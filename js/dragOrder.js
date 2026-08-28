// Réordonnancement d'une liste au doigt.
//
// Le geste : appui long, puis on déplace. L'appui long n'est pas un caprice —
// sans lui, ce geste entrerait en conflit avec les deux autres qui vivent sur
// les mêmes lignes : le défilement vertical de la liste et le balayage latéral
// qui découvre la suppression. Un délai franc les sépare sans ambiguïté.
//
// Aucune dépendance : ce module ne connaît ni kdbxweb ni le coffre. Il déplace
// des nœuds du DOM et annonce le résultat ; l'appelant décide ce que cela
// signifie pour les données.

const DELAI_APPUI = 350;      // ms avant que l'appui devienne une prise
const TOLERANCE = 10;         // px de bougé admis pendant l'appui long

/**
 * Rend une liste réordonnable au doigt.
 *
 * @param {object}   o
 * @param {Element}  o.liste            conteneur direct des éléments
 * @param {string}   o.selecteur        sélecteur des éléments déplaçables
 * @param {Function} o.deplacable       (element) => bool, consulté au début du geste
 * @param {Function} o.voisinsPossibles (element) => Element[] — les positions où
 *                   cet élément a le droit d'atterrir. Sert aux répertoires, où
 *                   un groupe ne peut se ranger qu'entre ses propres frères.
 * @param {Function} o.surDepot         (element, indexParmiVoisins) => void
 * @returns {Function} détache les écouteurs
 */
export function rendreReordonnable({ liste, selecteur, deplacable, voisinsPossibles, surDepot }) {
  let minuteur = null;
  let pris = null;          // élément saisi, ou null
  let depart = null;        // {x, y} du contact initial
  let voisins = [];

  const annulerAppui = () => {
    if (minuteur !== null) { clearTimeout(minuteur); minuteur = null; }
  };

  const relacher = () => {
    annulerAppui();
    if (!pris) return;
    const element = pris;
    pris = null;
    element.classList.remove('is-dragging');
    liste.classList.remove('is-reordering');
    surDepot(element, voisins.indexOf(element));
  };

  function onTouchStart(e) {
    if (e.touches.length !== 1) return;
    const element = e.target.closest(selecteur);
    if (!element || !liste.contains(element)) return;
    if (deplacable && !deplacable(element)) return;

    depart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    annulerAppui();
    minuteur = setTimeout(() => {
      minuteur = null;
      pris = element;
      voisins = voisinsPossibles ? voisinsPossibles(element) : [...liste.querySelectorAll(selecteur)];
      element.classList.add('is-dragging');
      liste.classList.add('is-reordering');
      // Retour tactile quand l'appareil sait le faire : c'est le seul signal
      // qui dise « c'est pris » sans regarder l'écran.
      if (navigator.vibrate) navigator.vibrate(12);
    }, DELAI_APPUI);
  }

  function onTouchMove(e) {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];

    // Pendant l'appui long, tout bougé franc annule la prise : l'utilisateur
    // voulait faire défiler ou balayer.
    if (minuteur !== null) {
      if (Math.abs(t.clientX - depart.x) > TOLERANCE
        || Math.abs(t.clientY - depart.y) > TOLERANCE) annulerAppui();
      return;
    }
    if (!pris) return;

    // Prise en cours : le déplacement nous appartient, le défilement s'arrête.
    e.preventDefault();

    // On déplace réellement le nœud dès que le doigt franchit le milieu d'un
    // voisin. Pas de fantôme ni d'espace réservé : la liste montre en direct
    // ce que sera le résultat, et il n'y a rien à réconcilier au dépôt.
    for (const voisin of voisins) {
      if (voisin === pris) continue;
      const r = voisin.getBoundingClientRect();
      const milieu = r.top + r.height / 2;
      const avant = pris.compareDocumentPosition(voisin) & Node.DOCUMENT_POSITION_FOLLOWING;
      if (avant && t.clientY > milieu) { voisin.after(pris); break; }
      if (!avant && t.clientY < milieu) { voisin.before(pris); break; }
    }
  }

  liste.addEventListener('touchstart', onTouchStart, { passive: true });
  liste.addEventListener('touchmove', onTouchMove, { passive: false });
  liste.addEventListener('touchend', relacher, { passive: true });
  liste.addEventListener('touchcancel', relacher, { passive: true });

  return () => {
    annulerAppui();
    liste.removeEventListener('touchstart', onTouchStart);
    liste.removeEventListener('touchmove', onTouchMove);
    liste.removeEventListener('touchend', relacher);
    liste.removeEventListener('touchcancel', relacher);
  };
}

/**
 * Équivalent clavier du même geste : Alt + flèches haut/bas.
 *
 * Le déplacement au doigt est inaccessible au clavier et aux lecteurs d'écran.
 * Sans cette voie, réordonner deviendrait une fonction réservée à ceux qui
 * peuvent viser un écran tactile.
 *
 * @returns {Function} détache l'écouteur
 */
export function rendreReordonnableAuClavier({ liste, selecteur, deplacable, voisinsPossibles, surDepot }) {
  function onKeyDown(e) {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const element = e.target.closest(selecteur);
    if (!element || !liste.contains(element)) return;
    if (deplacable && !deplacable(element)) return;

    const voisins = voisinsPossibles ? voisinsPossibles(element) : [...liste.querySelectorAll(selecteur)];
    const i = voisins.indexOf(element);
    const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= voisins.length) return;

    e.preventDefault();
    if (e.key === 'ArrowUp') voisins[j].before(element);
    else voisins[j].after(element);

    // Le focus suit l'élément déplacé, sinon la répétition du geste est
    // impossible : on perdrait la main après chaque pression.
    const cible = element.matches('button') ? element : element.querySelector('button');
    if (cible) cible.focus();

    surDepot(element, j);
  }

  liste.addEventListener('keydown', onKeyDown);
  return () => liste.removeEventListener('keydown', onKeyDown);
}
