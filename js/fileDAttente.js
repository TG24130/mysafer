// File d'attente à un seul fil, pour les opérations qui touchent au coffre.
//
// Pourquoi elle existe, très concrètement.
//
// `db.save()` de kdbxweb n'est pas réentrante. Elle réécrit l'en-tête du
// fichier — sels, vecteurs d'initialisation, empreinte d'en-tête — puis chiffre
// et compresse le corps à partir de cet en-tête. Deux appels entrelacés sur la
// même instance produisent un fichier dont l'en-tête ne correspond plus au
// corps : au déchiffrement, des octets aléatoires, donc « invalid gzip data ».
//
// C'est exactement ce qui s'est produit le 2026-09-01, deux fois. Un
// enregistrement lance `saveVault(db)`, puis une synchronisation en arrière-plan
// qui fusionne et re-sérialise — deux dérivations Argon2, plusieurs secondes.
// Un second enregistrement pendant ce temps, et les deux sérialisations se
// chevauchent. Le verrou existant ne protégeait que les cycles de
// synchronisation les uns des autres, jamais d'une écriture locale concurrente.
//
// La file règle le problème à la racine : une seule opération touche le coffre
// à la fois, quelle que soit son origine.

/**
 * Crée une file qui exécute les travaux l'un après l'autre.
 *
 * Un travail qui échoue ne bloque pas la file : l'échec est transmis à son
 * appelant, et le suivant démarre quand même. Sans cela, une synchronisation
 * en panne empêcherait tout enregistrement ultérieur — le remède serait pire
 * que le mal.
 *
 * @returns {(travail: () => Promise<any>) => Promise<any>}
 */
export function creerFile() {
  let queue = Promise.resolve();

  return function enfiler(travail) {
    // Le résultat rendu à l'appelant : sa valeur, ou son erreur.
    const resultat = queue.then(travail);
    // Ce sur quoi la file enchaîne : l'erreur y est absorbée, pour que la
    // chaîne ne se rompe pas et qu'aucun rejet ne reste non traité.
    queue = resultat.then(() => {}, () => {});
    return resultat;
  };
}
