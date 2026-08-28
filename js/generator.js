// Génération de secrets : phrases de passe (diceware) et mots de passe par
// jeu de caractères.
//
// Toute l'aléa vient de crypto.getRandomValues. Math.random n'est pas utilisé
// ici et ne doit jamais l'être : il est prévisible et n'a aucune valeur
// cryptographique.

const WORDLIST_URL = './js/vendor/eff-wordlist.json';

let wordlistPromise = null;

/**
 * Charge la liste de mots EFF (7776 entrées). Mise en cache après le premier
 * appel. Le service worker la précache, donc l'opération marche hors ligne.
 */
export function loadWordlist() {
  if (!wordlistPromise) {
    wordlistPromise = fetch(WORDLIST_URL)
      .then((r) => {
        if (!r.ok) throw new Error('liste de mots introuvable (HTTP ' + r.status + ')');
        return r.json();
      })
      .then((words) => {
        // Une liste tronquée réduirait silencieusement l'entropie : on refuse
        // plutôt que de générer une phrase plus faible que promis.
        if (!Array.isArray(words) || words.length !== 7776) {
          throw new Error('liste de mots invalide : ' + (Array.isArray(words) ? words.length : typeof words) + ' entrées au lieu de 7776');
        }
        return words;
      })
      .catch((err) => {
        wordlistPromise = null; // permettre une nouvelle tentative
        throw err;
      });
  }
  return wordlistPromise;
}

/**
 * Entier aléatoire uniforme dans [0, max[, sans biais.
 *
 * Le simple `getRandomValues() % max` est biaisé quand max ne divise pas 2^32 :
 * les petites valeurs sortent légèrement plus souvent. On rejette donc les
 * tirages qui tombent dans la zone incomplète. Sur 7776, le biais serait
 * minuscule mais réel, et il n'y a aucune raison de l'accepter.
 */
export function randomBelow(max) {
  if (!Number.isInteger(max) || max <= 0 || max > 0x100000000) {
    throw new RangeError('max hors limites : ' + max);
  }
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  let v;
  do {
    crypto.getRandomValues(buf);
    v = buf[0];
  } while (v >= limit);
  return v % max;
}

/** Tire un élément au hasard dans un tableau. */
export function pick(arr) {
  return arr[randomBelow(arr.length)];
}

// ---------------------------------------------------------------------------
// Phrases de passe
// ---------------------------------------------------------------------------

/** Entropie, en bits, d'une phrase de `count` mots tirés dans `listSize`. */
export function passphraseBits(count, listSize = 7776) {
  return count * Math.log2(listSize);
}

// Le séparateur par défaut n'est PAS le tiret. La liste EFF contient quatre
// mots composés — drop-down, felt-tip, t-shirt, yo-yo — et un tiret rendrait
// les frontières entre mots ambiguës : impossible de savoir, en relisant la
// phrase, si l'on a six mots ou sept. Le point n'apparaît dans aucun mot.
export const DEFAULT_SEPARATOR = '.';

/**
 * Génère une phrase de passe diceware.
 * @param {number} count nombre de mots (6 par défaut ≈ 77,5 bits)
 * @param {string} separator séparateur ; doit n'apparaître dans aucun mot
 * @param {string[]|null} words liste à utiliser ; par défaut celle chargée par
 *   loadWordlist(). Le paramètre existe pour que les tests tournent sous Node,
 *   où `fetch` d'une URL relative n'a pas de sens.
 */
export async function generatePassphrase(count = 6, separator = DEFAULT_SEPARATOR, words = null) {
  if (!Number.isInteger(count) || count < 1 || count > 24) {
    throw new RangeError('nombre de mots hors limites : ' + count);
  }
  const list = words || await loadWordlist();
  // Garde-fou plutôt que convention : un séparateur présent dans un mot
  // casserait la lisibilité de la phrase sans rien signaler.
  if (!separator || list.some((w) => w.includes(separator))) {
    throw new Error('séparateur invalide : « ' + separator + ' » apparaît dans la liste de mots');
  }
  const out = [];
  for (let i = 0; i < count; i++) out.push(pick(list));
  return out.join(separator);
}

// ---------------------------------------------------------------------------
// Mots de passe par jeu de caractères
// ---------------------------------------------------------------------------

// `l`, `I`, `1`, `O` et `0` sont exclus des jeux ambigus : ils se confondent à
// la lecture, ce qui compte pour un mot de passe qu'on doit parfois recopier
// à la main depuis un autre écran.
export const CHARSETS = {
  minuscules: 'abcdefghijkmnopqrstuvwxyz',
  majuscules: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  chiffres: '23456789',
  symboles: '!#$%&*+-=?@^_',
  minusculesCompletes: 'abcdefghijklmnopqrstuvwxyz',
  majusculesCompletes: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  chiffresComplets: '0123456789',
};

/**
 * Génère un mot de passe aléatoire.
 * @param {number} length longueur
 * @param {string[]} sets jeux de caractères à combiner (clés de CHARSETS ou
 *   chaînes littérales)
 * @param {boolean} requireEach garantir au moins un caractère de chaque jeu
 */
export function generatePassword(length = 20, sets = ['minuscules', 'majuscules', 'chiffres', 'symboles'], requireEach = true) {
  if (!Number.isInteger(length) || length < 4 || length > 256) {
    throw new RangeError('longueur hors limites : ' + length);
  }
  const resolved = sets.map((s) => CHARSETS[s] || s).filter(Boolean);
  if (!resolved.length) throw new Error('aucun jeu de caractères');
  if (requireEach && length < resolved.length) {
    throw new RangeError('longueur trop courte pour garantir un caractère de chaque jeu');
  }

  const all = resolved.join('');
  const chars = [];

  // Un caractère imposé par jeu, puis le reste au hasard dans l'union.
  if (requireEach) for (const set of resolved) chars.push(pick(set));
  while (chars.length < length) chars.push(pick(all));

  // Mélange de Fisher-Yates, sinon les caractères imposés resteraient en tête
  // et la position des symboles serait prévisible.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** Entropie, en bits, d'un mot de passe de `length` caractères sur `alphabetSize`. */
export function passwordBits(length, alphabetSize) {
  return length * Math.log2(alphabetSize);
}
