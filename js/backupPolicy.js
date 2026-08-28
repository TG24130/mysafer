// Politique de rétention des copies horodatées du coffre.
//
// Pourquoi ce module existe séparément de vaultBackup.js : décider quoi garder
// est de la logique pure, donc testable sous Node sans Firebase ni navigateur.
// Se tromper ici efface des sauvegardes — c'est exactement le genre de code qui
// ne doit pas être vérifié à la main sur des données réelles.
//
// Ce que ces copies protègent : perdre la phrase maîtresse est un risque
// accepté (décision 3). Perdre le blob par un défaut de synchronisation ou une
// mauvaise fusion ne l'est pas. Firebase Storage n'ayant pas d'écriture
// conditionnelle, deux envois simultanés peuvent s'écraser ; ces copies sont le
// filet correspondant.

/**
 * Schéma classique « grand-père, père, fils », choisi pour rester lisible :
 *   - les N plus récentes, quoi qu'il arrive — couvre l'erreur qu'on vient de
 *     faire, y compris plusieurs enregistrements rapprochés dans la même heure ;
 *   - une par jour sur 30 jours — couvre l'erreur remarquée quelques jours après ;
 *   - une par mois sur 12 mois — couvre la suppression jamais remarquée.
 *
 * À ~71 Ko la copie, une quarantaine de copies pèsent 3 Mo. Le quota gratuit
 * de Storage est de 5 Go : la rétention n'est pas contrainte par le coût, elle
 * l'est par la lisibilité de la liste.
 */
export const POLITIQUE_PAR_DEFAUT = Object.freeze({
  recentes: 10,
  jours: 30,
  mois: 12,
});

const JOUR = 86400000;

/** Clé de regroupement journalier, en UTC pour ne pas dépendre du fuseau. */
function cleJour(date) {
  return date.toISOString().slice(0, 10);      // AAAA-MM-JJ
}

/** Clé de regroupement mensuel. */
function cleMois(date) {
  return date.toISOString().slice(0, 7);       // AAAA-MM
}

/**
 * Décide quelles copies garder et lesquelles supprimer.
 *
 * @param {Array<{nom: string, date: Date}>} copies  liste, ordre indifférent
 * @param {Date}   maintenant  instant de référence
 * @param {object} [politique] voir POLITIQUE_PAR_DEFAUT
 * @returns {{garder: string[], supprimer: string[]}} noms, du plus récent au
 *          plus ancien pour `garder`
 */
export function trierCopies(copies, maintenant, politique = POLITIQUE_PAR_DEFAUT) {
  const triees = [...copies].sort((a, b) => b.date - a.date);
  const garder = new Set();

  // 1. Les N plus récentes, sans condition.
  for (const c of triees.slice(0, politique.recentes)) garder.add(c.nom);

  // 2. La plus récente de chaque jour, sur la fenêtre des N derniers jours.
  //    `triees` étant décroissante, la première rencontrée pour une clé donnée
  //    est bien la plus récente de ce jour.
  const limiteJours = maintenant.getTime() - politique.jours * JOUR;
  const joursVus = new Set();
  for (const c of triees) {
    if (c.date.getTime() < limiteJours) break;
    const k = cleJour(c.date);
    if (!joursVus.has(k)) { joursVus.add(k); garder.add(c.nom); }
  }

  // 3. La plus récente de chaque mois, sur les N derniers mois.
  const limiteMois = new Date(maintenant.getTime());
  limiteMois.setUTCMonth(limiteMois.getUTCMonth() - politique.mois);
  const moisVus = new Set();
  for (const c of triees) {
    if (c.date.getTime() < limiteMois.getTime()) break;
    const k = cleMois(c.date);
    if (!moisVus.has(k)) { moisVus.add(k); garder.add(c.nom); }
  }

  return {
    garder: triees.filter((c) => garder.has(c.nom)).map((c) => c.nom),
    supprimer: triees.filter((c) => !garder.has(c.nom)).map((c) => c.nom),
  };
}

/**
 * Nom de fichier d'une copie. Horodatage ISO, `:` remplacés parce qu'ils sont
 * mal supportés dans les chemins et pénibles à lire dans la console Firebase.
 * Le tri alphabétique de ces noms coïncide avec le tri chronologique, ce dont
 * dépend l'affichage de la console.
 */
export function nomDeCopie(date) {
  return date.toISOString().replace(/[:.]/g, '-') + '.kdbx';
}

/**
 * Relit la date depuis un nom produit par nomDeCopie().
 * @returns {Date|null} null si le nom ne suit pas le format — un fichier
 *          déposé à la main ne doit jamais être supprimé par erreur.
 */
export function dateDeCopie(nom) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.kdbx$/.exec(nom);
  if (!m) return null;
  const [, a, mo, j, h, mi, s, ms] = m;
  const d = new Date(Date.UTC(+a, +mo - 1, +j, +h, +mi, +s, +ms));
  if (Number.isNaN(d.getTime())) return null;

  // Vérification par aller-retour, et non par contrôle des bornes : Date.UTC
  // accepte silencieusement un mois 13 ou un jour 45 et les reporte sur la date
  // suivante. Un nom aberrant produirait donc une date valide, et le fichier
  // serait traité comme une copie automatique — donc supprimable par la
  // rotation. Seul un nom que l'on sait reproduire est reconnu.
  return nomDeCopie(d) === nom ? d : null;
}
