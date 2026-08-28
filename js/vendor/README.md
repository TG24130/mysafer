# Bibliothèques vendored

Ces fichiers sont copiés tels quels (pas de gestionnaire de paquets pour ce
projet). Vérifier la somme SHA-256 avant de remplacer un fichier permet de
détecter une altération accidentelle ou malveillante.

**Ces fichiers doivent rester servis depuis la même origine.** Le service worker
(`sw.js`) ignore délibérément tout ce qui est cross-origin ; une dépendance
chargée depuis un CDN ne serait jamais mise en cache et casserait le
déverrouillage hors ligne.

| Fichier | Bibliothèque | Version | Licence | SHA-256 |
|---|---|---|---|---|
| `kdbxweb.min.js` | [kdbxweb](https://github.com/keeweb/kdbxweb) | 2.1.1 | MIT | `d11e4d4f5316adcaadb349dad6df568e7a861faf0582bcc948a40efb21a41f98` |
| `argon2-bundled.min.js` | [argon2-browser](https://github.com/antelle/argon2-browser) | 1.18.0 | MIT | `77c64b946baf1a5116dc591f4b9965d636b1b455f75edd2d4a587cb75e01687b` |
| `noble-hashes/argon2.js` | [@noble/hashes](https://github.com/paulmillr/noble-hashes) | 2.3.0 | MIT | `81dc2ac30a721c578e39a1d93646d9a4c1b55fcaa5c60a809e0ad0ea7f5368a8` |
| `noble-hashes/blake2.js` | @noble/hashes | 2.3.0 | MIT | `03f00237bcc0b4d822a80f7c0ac22e42632c48e246c3b6da584e6452186e32f0` |
| `noble-hashes/utils.js` | @noble/hashes | 2.3.0 | MIT | `6b4397dd40cef490bb70bf59784d2b053dc331755700ae30ff28d30ec5fccb6b` |
| `noble-hashes/_blake.js` | @noble/hashes | 2.3.0 | MIT | `cabbff61d1f373bac45594ad758df7c42e176464ddbb94b44f5533fa977a4f56` |
| `noble-hashes/_md.js` | @noble/hashes | 2.3.0 | MIT | `60cf3010fda89e3e4d3f0e7ff1ce249e9c467f34b4fd41b6fd6101d9f69be763` |
| `noble-hashes/_u64.js` | @noble/hashes | 2.3.0 | MIT | `b09da8c07fe8187c07649494cdb7cd0bcf13df90b506a9473d19e4d5f8c2e102` |
| `eff-wordlist.json` | [eff-diceware-passphrase](https://www.npmjs.com/package/eff-diceware-passphrase) (liste EFF) | 3.0.0 | ISC | `2356977166b8de4eb3ab328fe584c54f83d6dd7ddd1fb18d56ecb8b801a28556` |
| `firebase/firebase-app.js` | [firebase-js-sdk](https://github.com/firebase/firebase-js-sdk) | 10.14.1 | Apache-2.0 | `19f05d67deadb1a1fba077c18611c3c9b2fdd5b4ebbd0a5e391498925ebae23e` |
| `firebase/firebase-auth.js` | firebase-js-sdk (**modifié**) | 10.14.1 | Apache-2.0 | `1c1b9ea1bd9ece91a2a4397c7334b1f0f94b65fca84529b7e6f9ba9a60c49b1f` |
| `firebase/firebase-storage.js` | firebase-js-sdk (**modifié**) | 10.14.1 | Apache-2.0 | `0cae158ec8ca34cd35f4a7c093aff927802d0e7c01316c7bc1ba13b6924b16e1` |

Vérification (PowerShell) :

```powershell
Get-FileHash js\vendor\kdbxweb.min.js -Algorithm SHA256
Get-ChildItem js\vendor\noble-hashes\*.js | Get-FileHash -Algorithm SHA256
```

## Provenance

Les deux paquets viennent de npm, sans modification :

```bash
npm pack kdbxweb@2.1.1         # dist/kdbxweb.min.js
npm pack argon2-browser@1.18.0 # dist/argon2-bundled.min.js
npm pack @noble/hashes@2.3.0   # argon2.js et ses dépendances relatives
```

`argon2-bundled.min.js` embarque son WebAssembly en base64 : il n'y a **aucun
fichier `.wasm` séparé à servir**, ce qui simplifie le précache du service
worker. Vérifié en coupant le serveur : le déverrouillage passe toujours par
WebAssembly hors ligne.

Note : le dépôt kdbxweb porte la version `2.2.0` dans son `package.json`, mais
la dernière version **publiée sur npm** est `2.1.1`. C'est celle-ci qui est
vendorée.

## Pourquoi ces six fichiers de @noble/hashes et pas plus

`argon2.js` n'importe que des chemins relatifs, et le graphe est clos :

```
argon2.js  →  _u64.js, blake2.js, utils.js
blake2.js  →  _blake.js, _md.js, _u64.js, utils.js
_blake.js  →  utils.js
_md.js     →  _u64.js, utils.js
_u64.js    →  (rien)
utils.js   →  (rien)
```

Aucune dépendance externe, aucun accès réseau. Si une mise à jour ajoute un
import, il faut vendorer le fichier correspondant et mettre ce tableau à jour.

## Audit du code minifié

`kdbxweb.min.js` est minifié. Pour relire la source avant de faire confiance à
une mise à jour, la version non minifiée est dans le même paquet npm :

```bash
npm pack kdbxweb@2.1.1
tar -xzf kdbxweb-2.1.1.tgz
# package/dist/kdbxweb.js  (non minifié, ~322 Ko)
```

## La liste de mots

`eff-wordlist.json` est la « EFF large wordlist » : **7776 mots, tous uniques**,
soit exactement 12,925 bits par mot et **77,5 bits pour une phrase de 6 mots**.
Ces trois propriétés sont vérifiées à l'exécution (`js/generator.js` refuse une
liste qui ne fait pas 7776 entrées) et par les tests
(`node tests/generator.test.mjs`).

Quatre mots sont composés — `drop-down`, `felt-tip`, `t-shirt`, `yo-yo`. C'est
la raison pour laquelle le séparateur par défaut des phrases est le **point** et
non le tiret : sinon les frontières entre mots deviennent ambiguës et une phrase
de six mots peut se relire comme sept. `generatePassphrase` refuse d'ailleurs
tout séparateur présent dans un mot de la liste.

**Cette liste est en anglais.** Pour un utilisateur francophone, six mots
français seraient plus faciles à mémoriser. Aucune liste française de qualité
équivalente n'a été trouvée sur npm au moment du choix ; la liste EFF a
l'avantage d'être un standard vérifiable. Le remplacement est un changement de
fichier, `js/generator.js` ne connaît que le chemin et la taille attendue.

## Pourquoi deux implémentations d'Argon2

`js/vaultCrypto.js` essaie WebAssembly d'abord et retombe sur JavaScript pur.
Ce n'est pas de la redondance décorative, il y a deux raisons mesurées :

1. **Vitesse.** Sur PC de bureau, à 64 Mio / 3 passes / 4 voies, en régime
   établi : WebAssembly ~230 ms contre ~765 ms en JavaScript pur, soit un
   facteur 3,3. À froid (compilation WebAssembly, chauffe du JIT) :
   ~1250 ms contre ~2060 ms. Un téléphone est 2 à 4 fois plus lent.
2. **Correction.** `argon2-browser` code la version d'Argon2 en dur
   (`lib/argon2.js` : `const version = 0x13`) et n'expose aucun paramètre pour
   la changer. Un coffre KDBX utilisant l'ancienne version `0x10` lui donnerait
   un hash faux, et donc un message « mot de passe incorrect » sur un mot de
   passe pourtant juste. `@noble/hashes` accepte la version : c'est lui qui
   traite ce cas.

Le repli sert aussi si WebAssembly est indisponible à l'exécution (CSP sans
`'wasm-unsafe-eval'`, environnement verrouillé) : le coffre reste ouvrable,
seulement plus lentement.

## Vérifications faites au moment du choix

- **`@xmldom/xmldom` n'est pas nécessaire dans un navigateur.** Le bundle UMD le
  déclare en `external`, mais `createDOMParser()` teste `globalThis.DOMParser`
  en premier ; la branche xmldom est du code mort côté navigateur. Confirmé à
  l'exécution : l'application fonctionne sans que xmldom soit servi.
- **Unité de mémoire Argon2.** kdbxweb appelle l'implémentation avec
  `memory / 1024`, donc l'argument reçu est déjà en kibioctets — l'unité
  attendue aussi bien par `@noble/hashes` (`m`) que par `argon2-browser`
  (`mem`). Aucune conversion à faire dans l'adaptateur. Se tromper ici
  produirait un coffre illisible par KeePassXC.
- **WebAssembly exige `'wasm-unsafe-eval'` dans la CSP.** Directive bien plus
  étroite que `'unsafe-eval'` : elle n'autorise que la compilation
  WebAssembly, pas l'évaluation de chaînes JavaScript.
- **Le fichier produit est un vrai KDBX 4.** Relu par kdbxweb sous Node
  (crypto Node + xmldom, chemin de code différent du navigateur) : signatures
  `0x9AA2D903` / `0xB54BFB67`, version 4.0, entrées intactes.
- **kdbxweb sous Node exige `@xmldom/xmldom` 0.8.x.** La 0.9 a supprimé
  l'option `errorHandler` que kdbxweb passe encore, d'où l'erreur
  « errorHandler object is no longer supported ». Sans effet sur le
  navigateur ; à savoir uniquement pour les tests Node.

## Le SDK Firebase a été modifié après téléchargement

Les fichiers sont téléchargés depuis `https://www.gstatic.com/firebasejs/10.14.1/`.
Tels quels, `firebase-auth.js` et `firebase-storage.js` importent `firebase-app.js`
par son URL absolue sur `gstatic.com` — le navigateur irait donc chercher le
SDK sur le réseau malgré le vendoring, ce que la CSP refuse et que le service
worker ne mettrait pas en cache.

Cette URL absolue a été remplacée par `./firebase-app.js` dans ces deux
fichiers. **Leurs sommes SHA-256 ci-dessus ne correspondent donc pas à celles
des fichiers d'origine** ; `firebase-app.js`, lui, est intact.

Pour reproduire la modification lors d'une mise à jour de version :

```bash
curl -O https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js
curl -O https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js
curl -O https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js
sed -i 's|https://www\.gstatic\.com/firebasejs/10\.14\.1/firebase-app\.js|./firebase-app.js|g'   firebase-auth.js firebase-storage.js
```

Deux occurrences de l'URL subsistent volontairement dans `firebase-app.js` :
ce sont une chaîne de nom de paquet et une étiquette de journalisation,
sans effet réseau.

Seuls `identitytoolkit.googleapis.com`, `securetoken.googleapis.com` et
`firebasestorage.googleapis.com` ont été ajoutés à `connect-src`. Les URL
`recaptcha` et `apis.google.com` présentes dans `firebase-auth.js` ne servent
qu'à l'authentification par téléphone et aux fenêtres OAuth, que ce projet
n'utilise pas : elles ne sont jamais chargées.
