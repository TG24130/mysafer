# Coffre

Coffre-fort de mots de passe personnel. PWA locale-first, format **KDBX**
(KeePass), fonctionnelle hors ligne.

État : **phases 0 à 3 terminées** (socle, crypto, stockage local, répertoires,
détail d'entrée, générateur, recherche, export, verrouillage automatique).
Voir « Feuille de route » plus bas.

## Nature de l'application

- **100 % client, sans build.** HTML/CSS/JS pur, aucun framework, aucun
  `package.json`, aucun bundler. Les fichiers sont servis tels quels.
- **Locale-first.** Le coffre vit dans IndexedDB (base `coffre_db`), chiffré,
  sous la forme d'un fichier `.kdbx` exactement comme il serait sur disque. La
  clé maître n'est jamais persistée : elle n'existe qu'en mémoire pendant la
  session déverrouillée.
- **PWA installable**, service worker réseau-d'abord (`sw.js`).

### Pourquoi KDBX

Le coffre reste lisible par KeePassXC, KeePassDX, KeePassium et Strongbox. Deux
conséquences directes :

- **La saisie automatique dans le navigateur n'a pas à être développée ici.**
  C'est le composant le plus difficile à écrire, et les seules bonnes
  implémentations libres sont sous GPL. L'utilisateur emploie l'outil de son
  choix sur le même fichier.
- **Aucune captivité.** Si cette application disparaît, le coffre s'ouvre
  ailleurs.

## Démarrer en local

Aucune installation nécessaire :

```bash
python -m http.server 5174 --directory .
```

puis ouvrir <http://localhost:5174>.

## Fichiers principaux

| Fichier | Rôle |
|---|---|
| `js/vaultCrypto.js` | Branche Argon2 sur kdbxweb ; création, ouverture, écriture du KDBX |
| `js/vaultDb.js` | IndexedDB : blob `.kdbx` chiffré + métadonnées de synchro |
| `js/app.js` | Interface : déverrouillage, liste, ajout, export |
| `js/vaultModel.js` | Lecture du contenu : arborescence, tri, recherche — fonctions pures, testées |
| `js/generator.js` | Phrases de passe diceware et mots de passe, tirés de `crypto.getRandomValues` |
| `js/argon2Worker.js` | Argon2 hors du fil principal — WebAssembly, repli JavaScript |
| `js/lockTimer.js` | Verrouillage par inactivité, resistant aux minuteries suspendues |
| `js/clipboard.js` | Copie de secrets et effacement du presse-papiers |
| `diagnostic.html` | Test du support WebAuthn PRF, à lancer sur chaque appareil |
| `js/vendor/` | kdbxweb, argon2-browser, @noble/hashes — voir son `README.md` |
| `sw.js` | Service worker ; précache tout ce qu'exige le déverrouillage hors ligne |

## Deux contraintes structurantes

**1. Tout ce qui sert au déverrouillage est servi depuis la même origine.**
`sw.js` ignore délibérément les requêtes cross-origin. Une dépendance chargée
depuis un CDN ne serait jamais mise en cache et casserait le mode hors ligne.
C'est pourquoi kdbxweb et Argon2 sont vendorés plutôt que liés à un CDN. Le SDK
Firebase (phase 4) pourra rester distant : il ne sert qu'à la synchronisation,
qui suppose déjà le réseau.

**2. `CACHE_NAME` doit être incrémenté à chaque déploiement notable.**
L'événement `activate` supprime tous les caches dont le nom diffère. Sans cela,
un téléphone peut servir une version ancienne indéfiniment.

## Performance du déverrouillage

Mesuré le 2026-08-26, PC de bureau, Argon2id 64 Mio / 3 passes / 4 voies :

| Implémentation | Premier déverrouillage (à froid) | Déverrouillages suivants |
|---|---|---|
| WebAssembly (`argon2-browser`) | **~1250 ms** | **~230 ms** |
| JavaScript pur (`@noble/hashes`) | ~2060 ms | ~765 ms |

L'écart entre les deux colonnes est le coût de démarrage : compilation du
WebAssembly d'un côté, chauffe du JIT de l'autre. Il se paie une fois par
chargement de page, pas à chaque déverrouillage — ce qui compte ici, puisque le
verrouillage automatique de 5 minutes reverrouille sans recharger la page.

En régime établi WebAssembly est **3,3 fois plus rapide**. Il est donc utilisé
par défaut, avec repli automatique sur JavaScript pur (voir
`js/vendor/README.md` pour les deux raisons — vitesse et gestion de la version
0x10).

Un téléphone reste 2 à 4 fois plus lent que ces chiffres. **À mesurer sur
l'appareil réel** avant de figer les paramètres du KDF (`DEFAULT_KDF` dans
`js/vaultCrypto.js`).

Argon2 tourne dans un **Web Worker** (`js/argon2Worker.js`) : le calcul
WebAssembly s'exécute d'un bloc et figeait l'interface pendant toute sa durée.
Vérifié après déplacement — 48 images rendues pendant une dérivation, contre un
fil principal totalement bloqué auparavant.

C'est un worker **classique** et non un worker de module, pour une raison
précise : `argon2-bundled.min.js` est un bundle UMD dont l'enveloppe évalue
`this` au niveau supérieur. Dans un module ES, `this` y vaut `undefined` et le
bundle plante à l'initialisation. Un worker classique lui donne `self`. Le repli
`@noble/hashes`, lui, est un module ES, chargé par `import()` dynamique — ce que
les workers classiques acceptent.

**Ce coût n'est pas payé à chaque ouverture.** À partir de la phase 5, le
déverrouillage quotidien passe par WebAuthn : une assertion biométrique déballe
une clé maître déjà dérivée, en quelques millisecondes. Argon2 ne tourne que sur
un appareil neuf ou en repli par mot de passe.

## Phrase de passe maître

Le choix retenu est **une phrase de 6 mots tirés au hasard** dans la liste EFF,
soit 77,5 bits d'entropie. Jamais des mots choisis soi-même : l'entropie annoncée
ne vaut que si le tirage est aléatoire.

Ce choix vient d'un arbitrage explicite. Durcir Argon2 rapporte peu — passer de
64 Mio / 3 passes à 256 Mio / 8 passes multiplie le coût de l'attaquant par
environ 10, soit l'équivalent de **3 bits**, au prix d'un déverrouillage dix fois
plus long. Ajouter **un seul mot** à la phrase rapporte **12,9 bits**, quatre
fois plus, sans une milliseconde d'attente. La sécurité de l'ensemble est
dominée par l'entropie de la phrase, pas par les réglages du KDF.

Le déverrouillage biométrique (phase 5) est ce qui rend cette phrase tenable :
elle n'est saisie qu'une fois par appareil, pas à chaque reprise après
verrouillage.

## Verrouillage automatique

Cinq minutes sans activité, puis verrouillage : le coffre est fermé, la clé
maître abandonnée, la liste et l'arborescence effacées du DOM. Un compte à
rebours apparaît dans la dernière minute — un compteur permanent serait une
nuisance, un avertissement tardif est une information.

**Le piège évité** : ne pas se reposer sur un seul `setTimeout`. Les navigateurs
mobiles brident puis suspendent les minuteries d'un onglet en arrière-plan. Un
téléphone rangé dans une poche pendant une heure reviendrait sans que rien
n'ait tiré, coffre grand ouvert. La minuterie ne sert donc qu'au cas courant :
la vérité est l'horodatage de la dernière activité, comparé à l'heure réelle au
retour au premier plan (`visibilitychange`) et à la restauration depuis le cache
de navigation (`pageshow`). Testé en simulant dix minutes de veille sans
qu'aucune minuterie ne tire.

## Presse-papiers

**Contrainte mesurée, et non supposée.** Écrire dans le presse-papiers exige une
activation transitoire — un geste récent de l'utilisateur. Vérifié dans
Chromium : permission `clipboard-write` à `granted`, document focalisé, et
l'écriture hors geste échoue quand même avec `NotAllowedError`.

Une purge par simple `setTimeout` ne s'exécute donc **jamais**. La première
version de ce module faisait exactement cela, pendant que l'interface annonçait
« Copié 25s ». Un échec silencieux est ici pire que pas de purge du tout : il
donne une fausse assurance.

Fonctionnement retenu : au bout du délai on tente l'écriture ; si elle est
refusée, un effacement est armé sur le **prochain geste** de l'utilisateur, et
le bandeau l'annonce. L'interface ne dit que ce qui s'est réellement produit.

Limite résiduelle assumée : la purge ne peut pas vérifier que c'est bien notre
valeur qui se trouve encore dans le presse-papiers — lire demande une permission
que ce coffre ne réclame pas (`clipboard-read` est à `denied` par défaut). Si
vous copiez autre chose entre-temps depuis une autre application, la purge
effacera votre sélection.

## Choix d'interface notables

- **« Exporter » vit dans le panneau des répertoires, pas dans la barre du
  haut.** C'est une action de maintenance, pas un geste quotidien ; la barre
  débordait sur écran étroit.
- **La confirmation de la phrase maîtresse n'est jamais pré-remplie.** La
  ressaisir est la seule preuve qu'elle a bien été notée quelque part.
- **Les champs personnalisés KDBX sont affichés en lecture seule.** Ne pas les
  montrer donnerait l'impression qu'ils ont été perdus à l'import.
- **Le mot de passe est masqué à l'ouverture d'une entrée**, et les champs du
  panneau de détail sont vidés à sa fermeture.

## Sécurité

- CSP stricte en `<meta>` : aucun script ni style en ligne, aucune origine
  externe. `'wasm-unsafe-eval'` est nécessaire à Argon2 en WebAssembly ;
  c'est une directive bien plus étroite que `'unsafe-eval'`, elle n'autorise
  pas l'évaluation de chaînes JavaScript.
- Protection anti-cadrage en JavaScript (`js/app.js`), faute de pouvoir
  définir `frame-ancestors` sur GitHub Pages.
- Les mots de passe sont stockés en `ProtectedValue` (kdbxweb), chiffrés en
  mémoire et marqués protégés dans le fichier.
- **Limite assumée** : JavaScript ne permet pas d'effacer la mémoire de façon
  garantie (chaînes immuables, ramasse-miettes). `ProtectedValue` réduit
  l'exposition, il ne l'élimine pas.
- **Perdre le mot de passe maître, c'est perdre le coffre.** Il n'y a aucune
  récupération, par conception.

## Feuille de route

| Phase | Contenu | État |
|---|---|---|
| 0 | Socle PWA, vendoring, vérifications de format | fait |
| 1 | Coffre local chiffré, hors ligne complet | fait |
| 2 | Interface : répertoires, détail d'entrée, générateur, recherche | fait |
| 3 | Verrouillage automatique 5 min, presse-papiers, Argon2 en worker | fait |
| 4 | Synchronisation Firebase Storage + fusion multi-appareils | à faire |
| 5 | Ouverture biométrique (WebAuthn PRF) | à faire — `diagnostic.html` prêt |
| 6 | Sauvegarde indépendante et export automatique | à faire |
| 7 | Passe de design | à faire |

Plan détaillé : `~/.claude/plans/polymorphic-foraging-dolphin.md`.
Recherche des briques : `../Quittance-Facile/.github-research/latest.md`.

## Vérifications déjà passées

1. Création d'un coffre, ajout d'entrées, rechargement : données intactes.
2. Tri alphabétique correct, accents compris (« Électricité » classé en E).
3. **Serveur arrêté** : la page se charge depuis le cache, Argon2 tourne en
   WebAssembly, le coffre s'ouvre en 1256 ms, l'écriture et la relecture
   fonctionnent.
4. Le `.kdbx` produit est relu par kdbxweb sous Node — implémentation et
   dépendances différentes du navigateur : signatures `0x9AA2D903` /
   `0xB54BFB67`, KDBX 4.0, entrées intactes.

5. Générateur : absence de biais du tirage, respect des jeux de caractères,
   mélange effectif des caractères imposés, refus d'un séparateur ambigu.
6. Création d'un coffre avec phrase générée : 6 mots, avertissement affiché,
   confirmation laissée vide volontairement (il faut la ressaisir, donc l'avoir
   notée), refus si les deux saisies diffèrent, phrase effacée du DOM après
   création.
7. Répertoires : création, déplacement d'une entrée, comptes par répertoire,
   filtrage, persistance après rechargement.
8. Recherche : insensible à la casse et aux accents (« electricite » trouve
   « Électricité »), et ne parcourt **ni les mots de passe ni les notes** — sans
   quoi le champ de recherche deviendrait un oracle révélant leur contenu.
9. Mise en page : aucun débordement horizontal de 291 px à 1100 px de large ;
   panneau des répertoires repliable sur téléphone, colonne permanente au-delà
   de 820 px.

## Tests

```bash
node tests/generator.test.mjs
node tests/vaultModel.test.mjs
node tests/lockTimer.test.mjs
```

64 tests, pas de framework, pas de dépendance : assertions Node, sur le modèle
de `Quittance-Facile/webapp/tests/`.

`vaultModel.js` est testable sous Node parce qu'il ne dépend d'aucune classe
concrète : il reconnaît un champ protégé à sa méthode `getText()`, pas à son
type. Les tests utilisent donc de faux groupes et de fausses entrées, sans
kdbxweb ni fichier `.kdbx`.

10. Verrouillage : dix minutes de veille simulées sans qu'aucune minuterie ne
    tire, puis retour au premier plan — verrouillage immédiat, liste,
    arborescence, portée et compte à rebours effacés, panneau de détail fermé.
11. Compte à rebours : apparaît à 42 s restantes, disparaît dès qu'une activité
    est signalée, et le verrouillage est repoussé.
12. Argon2 en worker : 48 images rendues pendant la dérivation — le fil
    principal reste vivant.

## Reste à vérifier manuellement

1. Ouvrir un `.kdbx` exporté dans **KeePassXC** — confirme l'interopérabilité
   avec une base de code entièrement étrangère.
2. Ouvrir `diagnostic.html` **sur le PC et sur le téléphone**, dans le vrai
   navigateur. Le point décisif est le déterminisme de la sortie PRF : si deux
   appels avec le même sel donnent des valeurs différentes, le déverrouillage
   biométrique est impossible sur cet appareil et il faut le savoir avant de
   construire la phase 5, pas après.

   Attention : WebAuthn exige un contexte sécurisé. Tester le téléphone sur
   `http://192.168.x.x` échouera toujours, quel que soit l'appareil — il faut
   l'adresse HTTPS déployée.
3. Le **test du presse-papiers**, en bas de `diagnostic.html`. Il doit être
   lancé par un vrai clic : les événements synthétiques ne portent pas
   d'activation utilisateur, donc cette partie n'a pas pu être vérifiée
   automatiquement. Le test indique si l'effacement différé fonctionne seul sur
   votre navigateur, ou s'il sera reporté à votre prochain clic.
