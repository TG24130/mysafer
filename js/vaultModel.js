// Lecture et interrogation du contenu d'un coffre KDBX.
//
// Volontairement composé de fonctions pures, sans accès au DOM ni à kdbxweb :
// tout ce qui est ici se teste sous Node avec de faux groupes et de fausses
// entrées (voir tests/vaultModel.test.mjs).
//
// Une seule convention à connaître : un champ « protégé » (le mot de passe) est
// un objet muni d'une méthode getText(). On le reconnaît par sa forme et non
// par `instanceof ProtectedValue`, précisément pour ne pas dépendre de kdbxweb.

/** Champs standard d'une entrée KDBX. */
export const FIELDS = ['Title', 'UserName', 'Password', 'URL', 'Notes'];

/**
 * Champs postaux, stockés comme champs personnalisés KDBX.
 *
 * Le format KDBX ne prévoit que cinq champs standard ; tout le reste vit en
 * champs nommés libres. Ceux-ci sont donc de vrais champs KDBX, lisibles et
 * modifiables dans KeePassXC comme dans KeePassDX — pas une invention locale
 * qui se perdrait à l'export.
 *
 * Ils sont listés ici pour être exclus de customFields() : sans cela ils
 * s'afficheraient deux fois, une fois dans leur champ propre et une fois dans
 * le bloc en lecture seule.
 */
export const POSTAL_FIELDS = ['Adresse', 'Ville', 'Code postal'];

/** Libellés français des champs standard. */
export const FIELD_LABELS = {
  Title: 'Titre',
  UserName: 'Identifiant',
  Password: 'Mot de passe',
  // « Adresse » désigne désormais l'adresse postale : l'URL doit dire ce
  // qu'elle est, sous peine de deux champs homonymes dans la même fiche.
  URL: 'Adresse web',
  Notes: 'Notes',
};

/**
 * Lit un champ d'entrée sous forme de texte.
 * Gère les trois formes possibles : absent, chaîne, valeur protégée.
 */
export function fieldText(entry, name) {
  const v = entry.fields.get(name);
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v.getText === 'function') return v.getText();
  return String(v);
}

/** Nom affichable d'un groupe. `name` est optionnel dans le format KDBX. */
export function groupName(group) {
  return group.name || 'Sans nom';
}

/**
 * Construit l'arborescence des groupes, à plat, avec la profondeur de chacun.
 * L'ordre est celui du parcours en profondeur : c'est l'ordre d'affichage.
 *
 * La corbeille KDBX est marquée mais pas retirée — c'est à l'appelant de
 * décider de l'afficher ou non.
 */
export function flattenGroups(db, { includeRecycleBin = false } = {}) {
  const recycleBinUuid = db.meta && db.meta.recycleBinUuid
    ? String(db.meta.recycleBinUuid) : null;
  const out = [];

  const walk = (group, depth) => {
    const uuid = String(group.uuid);
    const isRecycleBin = recycleBinUuid !== null && uuid === recycleBinUuid;
    if (isRecycleBin && !includeRecycleBin) return;
    out.push({
      group,
      uuid,
      depth,
      name: groupName(group),
      isRecycleBin,
      entryCount: group.entries.length,
    });
    for (const sub of group.groups) walk(sub, depth + 1);
  };

  for (const root of db.groups) walk(root, 0);
  return out;
}

/**
 * Liste les entrées d'un groupe.
 *
 * La corbeille est écartée de la descente récursive. Elle est un sous-groupe
 * de la racine comme un autre : sans cette exclusion, une entrée supprimée
 * restait comptée dans la racine et réapparaissait dans sa liste, ce qui
 * donnait une suppression qui « ne prend pas ».
 *
 * Le coffre est le premier argument pour que l'exclusion ne puisse pas être
 * oubliée à l'appel — c'est exactement l'oubli qui a produit le défaut.
 *
 * @param {object}  db        coffre (instance Kdbx), pour connaître la corbeille
 * @param {object}  group     groupe de départ
 * @param {boolean} recursive inclure les sous-groupes
 */
export function entriesOf(db, group, recursive = true) {
  const recycleBinUuid = db && db.meta && db.meta.recycleBinUuid
    ? String(db.meta.recycleBinUuid) : null;
  const out = [];
  const walk = (g) => {
    for (const e of g.entries) out.push({ entry: e, group: g });
    if (!recursive) return;
    for (const sub of g.groups) {
      if (recycleBinUuid !== null && String(sub.uuid) === recycleBinUuid) continue;
      walk(sub);
    }
  };
  walk(group);
  return out;
}

/** Toutes les entrées du coffre, hors corbeille. */
export function allEntries(db) {
  const out = [];
  for (const { group } of flattenGroups(db)) {
    for (const e of group.entries) out.push({ entry: e, group });
  }
  return out;
}

/**
 * Tri alphabétique par titre.
 *
 * `localeCompare` avec sensitivity 'base' est indispensable ici : sans lui,
 * « Électricité » se retrouverait après « Zenith » parce que É a un point de
 * code supérieur à Z. Avec lui, É se classe comme E.
 */
export function sortByTitle(rows) {
  return [...rows].sort((a, b) =>
    fieldText(a.entry, 'Title').localeCompare(
      fieldText(b.entry, 'Title'), 'fr', { sensitivity: 'base' }
    )
  );
}

/**
 * Filtre des entrées sur une requête libre.
 *
 * La comparaison ignore la casse ET les accents : chercher « electricite »
 * doit trouver « Électricité », sinon la recherche est inutilisable au clavier.
 * Le mot de passe et les notes ne sont volontairement PAS parcourus — on ne
 * veut pas qu'une frappe dans le champ de recherche révèle indirectement
 * qu'un mot de passe contient telle sous-chaîne.
 */
export function normalize(s) {
  // NFD sépare « é » en « e » + accent combinant, puis on retire la plage des
  // diacritiques combinants (U+0300 à U+036F). Écrite en échappements et non
  // en caractères bruts : ces derniers sont invisibles dans un éditeur et se
  // perdent au premier problème d'encodage.
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr');
}

export function searchEntries(rows, query) {
  const q = normalize(query.trim());
  if (!q) return rows;
  return rows.filter(({ entry, group }) => {
    const haystack = normalize([
      fieldText(entry, 'Title'),
      fieldText(entry, 'UserName'),
      fieldText(entry, 'URL'),
      // Chercher « Lyon » ou un code postal doit trouver la fiche : c'est
      // souvent tout ce dont on se souvient d'un compte administratif.
      fieldText(entry, 'Ville'),
      fieldText(entry, 'Code postal'),
      groupName(group),
    ].join(' '));
    return haystack.includes(q);
  });
}

/**
 * Champs personnalisés d'une entrée : tout ce qui n'est pas un champ standard.
 * KDBX autorise n'importe quelle clé ; on ne veut pas les perdre à l'affichage.
 */
export function customFields(entry) {
  const out = [];
  for (const key of entry.fields.keys()) {
    if (FIELDS.includes(key) || POSTAL_FIELDS.includes(key)) continue;
    out.push({ key, value: fieldText(entry, key) });
  }
  return out;
}

/** Domaine d'une URL, pour l'affichage. Renvoie '' si l'URL est inexploitable. */
export function urlHost(url) {
  if (!url) return '';
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : 'https://' + url).hostname;
  } catch {
    return '';
  }
}
