# Reprise de session — Coffre

Dernière session : **2026-08-28**. À lire en premier au démarrage d'une nouvelle
session. Le détail technique est dans `README.md` ; ce fichier ne dit que l'état
et la suite.

## Reprise immédiate — phase 4, synchronisation Firebase

Point d'avancement au 2026-08-27, fin de session.

### Fait

**Les deux projets Firebase existent et sont configurés à l'identique.**
Le nom `coffre-fort` étant déjà pris, la production porte l'identifiant
`coffre-fort-ae72c` ; le projet de test a gardé `coffre-fort-test`.

Pour chacun : authentification e-mail/mot de passe activée, forfait Blaze
rattaché au compte de facturation existant (celui de `gestion-loc-sci`, aucune
nouvelle carte saisie), bucket Cloud Storage créé en région **US**, règles en
mode production (`allow read, write: if false;`), application web enregistrée
sans Firebase Hosting.

Blaze est obligatoire depuis le 03/02/2026 pour tout nouveau bucket Cloud
Storage. Les quotas gratuits sont inchangés et l'usage réel — un `.kdbx` de
quelques centaines de kilooctets synchronisé quelques fois par jour — reste à
moins de 1 % du seuil le plus serré. Coût attendu : zéro.

**Région US assumée.** Le contenu est chiffré côté client, Google ne stocke
qu'un blob illisible ; la latence transatlantique est négligeable à cette
taille ; usage personnel, pas de RGPD à documenter (décision 3). La région du
bucket par défaut est définitive, mais Blaze autorise des buckets
supplémentaires : un bucket `europe-west1` reste créable plus tard sans rien
casser.

**Configurations récupérées.** Ces valeurs ne sont pas des secrets : elles sont
visibles dans le code de toute application web, la protection venant des règles
de sécurité Storage. Elles sont déjà inscrites dans `js/firebaseInit.js`.

| | Production | Test |
|---|---|---|
| `projectId` | `coffre-fort-ae72c` | `coffre-fort-test` |
| `apiKey` | `AIzaSyB6m2yV6hwfFgrCOBBPm_bMoGmQERceJYk` | `AIzaSyAYF-m-P8yCsK2zAor2mQaxjxx8wl7Z8n0` |
| `messagingSenderId` | `154169435805` | `767920379802` |
| `appId` | `1:154169435805:web:778cc6de4ad065cf4a1674` | `1:767920379802:web:ff3ba48c9933cf54a84c23` |

**SDK Firebase vendoré** dans `js/vendor/firebase/` (10.14.1, ~300 Ko).
Décision : ne pas charger le SDK depuis `gstatic.com`. La CSP du projet
interdit tout script hors origine et le service worker ignore le cross-origin ;
ouvrir `script-src` pour un coffre-fort de mots de passe serait un mauvais
échange. `firebase-auth.js` et `firebase-storage.js` ont dû être modifiés —
leur import de `firebase-app.js` pointait sur une URL absolue `gstatic.com`.
Procédure de mise à jour et sommes SHA-256 dans `js/vendor/README.md`.

**Écrits :** `js/firebaseInit.js` (bascule PROD/TEST par nom d'hôte, bandeau
orange en test) et `js/firebaseAuth.js` (connexion e-mail/mot de passe,
`onAuthChange`, `currentUid`). Aucun n'est encore importé par `js/app.js` :
sans effet sur l'application à ce stade.

**`connect-src` élargie** dans `index.html` à `identitytoolkit.googleapis.com`,
`securetoken.googleapis.com` et `firebasestorage.googleapis.com`, et à eux
seuls. `script-src` reste `'self' 'wasm-unsafe-eval'`.

**Service worker :** les cinq nouveaux fichiers ajoutés à `CORE_ASSETS`,
`CACHE_NAME` porté à `coffre-cache-2026082701`.

Les 64 tests existants passent toujours (20 + 26 + 18).

### Cycle de fusion écrit et éprouvé

`js/mergeCycle.js` — télécharger, fusionner, renvoyer — délibérément séparé du
transport : il ne connaît ni Firebase ni `window`, et tourne donc sous Node.
C'est ce qui rend `tests/mergeLogic.test.mjs` possible : deux appareils, un faux
Storage en mémoire, aucun réseau ni compte, avec le **vrai** kdbxweb.

Dix scénarios passent : premier envoi, création concurrente, modification
concurrente (la plus récente gagne, l'écartée reste dans l'historique),
propagation d'une suppression, non-résurrection au cycle suivant, suppression
contre modification, envoi en échec, convergence complète.

### Faits mesurés sur la fusion — ne pas les re-dériver

- **Les horodatages KDBX ont une résolution d'une seconde.** Un test qui
  s'exécute d'un trait fait tout tomber dans la même seconde : les temps sont à
  égalité, la fusion ne peut pas trancher, chaque appareil garde sa version et
  la divergence paraît permanente. Ce n'est pas un défaut du produit. Les tests
  datent donc tout explicitement plutôt que d'attendre réellement.
- **kdbxweb ne met PAS à jour `lastModTime` quand un champ change.** C'est à
  l'appelant d'appeler `entry.times.update()`. Sans cela, deux appareils
  divergent en silence et définitivement — c'est la panne la plus dangereuse
  du lot, et exactement la forme de l'incident d'août. `js/app.js` le fait déjà
  (`pushHistory()` puis `times.update()`, lignes 405 et 417) ; toute autre voie
  d'écriture devra faire de même.
- **Une suppression KDBX est un déplacement daté vers la corbeille**, pas un
  effacement, et pas une pierre tombale. C'est `locationChanged` qui arbitre.
- **`setLocalEditState` n'a aucun effet observable** sur les scénarios couverts,
  redémarrage de l'application compris — vérifié en exécutant chaque scénario
  avec et sans. L'appel est conservé (marche à suivre publiée par kdbxweb, coût
  nul), et un test fige ce constat pour alerter si une version ultérieure
  change ce comportement.
- **`String()` sur un champ protégé renvoie la forme chiffrée**, différente à
  chaque appel. Seul `getText()` donne le contenu. Comparer deux mots de passe
  sans `getText()` fait croire à une divergence qui n'existe pas.

### Dépendances de test

Un `package.json` a été ajouté, avec `"type": "module"` — sans lui, Node
émettait un avertissement à chaque import de `js/*.js`. `npm test` enchaîne les
cinq suites, **86 tests** au total (20 + 26 + 18 + 10 + 12).

Seule dépendance : `@xmldom/xmldom` 0.8.10, en devDependency. kdbxweb l'exige
sous Node (la 0.9 a supprimé l'option `errorHandler`) ; dans un navigateur,
kdbxweb utilise le `DOMParser` natif et cette bibliothèque est du code mort.
npm signale des failles connues sur cette version : contrainte assumée, elle
n'est jamais déployée et ne lit que du XML produit par les tests eux-mêmes.

`js/vendor/kdbxweb.min.js` étant un bundle UMD dans un projet déclaré
`"type": "module"`, le test lui fournit explicitement l'enveloppe CommonJS qu'il
attend (`new Function('module', 'exports', 'require', source)`).

### Branchement fait

Console Firebase : règles publiées et utilisateur créé dans les deux projets.
Les règles sont désormais versionnées dans `storage.rules` — les recopier depuis
ce fichier plutôt que depuis une conversation.

Code : `js/syncController.js` assemble authentification, transport, fusion et
stockage local ; `js/app.js` s'en sert seul. L'écran de verrouillage a un bloc
« Synchronisation » (connexion, déconnexion, état). Un appareil neuf connecté
télécharge le coffre distant et ne l'installe qu'une fois la phrase maîtresse
vérifiée. La synchronisation part en arrière-plan au déverrouillage et après
chaque enregistrement, sans jamais bloquer l'enregistrement local, avec un
verrou empêchant deux cycles simultanés. L'en-tête du coffre affiche l'état.

`syncVault()` rend maintenant les octets envoyés : l'appelant les enregistre
localement au lieu de re-sérialiser, ce qui épargne une dérivation Argon2 de
64 Mio à chaque synchronisation — une à deux secondes sur téléphone.

### Vérifié dans le navigateur (2026-08-27) — phase 4 close

Testé de bout en bout sur `localhost:5174`, donc contre `coffre-fort-test`, avec
le vrai compte :

- connexion, création d'un coffre, envoi, statut « Synchronisé », fichier
  présent dans Storage sous `users/{uid}/vault/db.kdbx` ;
- **récupération sur appareil neuf** : coffre local effacé, session conservée,
  l'application propose « Coffre récupéré en ligne », le coffre se télécharge et
  s'ouvre à la phrase maîtresse avec son contenu intact ;
- bascule d'environnement correcte (bandeau orange, projet de test sur
  localhost), page chargée sans erreur.

La fusion entre appareils concurrents n'a pas été rejouée à la main : elle est
couverte par les 10 tests de `tests/mergeLogic.test.mjs`, qui utilisent le vrai
kdbxweb. Refaire le scénario dans deux navigateurs n'aurait rien prouvé de plus.

Astuce de test, plus rapide que d'ouvrir un second navigateur : effacer le
coffre local sans toucher à la session, avec
`indexedDB.deleteDatabase('coffre_db')` dans la console, puis recharger. Une
simple nouvelle fenêtre ne suffit pas — même profil, même stockage, donc même
appareil du point de vue de l'application.

### CORS : l'autorisation invisible — cause d'un long blocage

**Firebase Storage exige que l'origine du site soit autorisée sur le bucket
lui-même.** C'est une autorisation distincte des règles de sécurité, elle ne
figure nulle part dans la console Firebase, et rien ne la signale : sans elle,
tout envoi et tout téléchargement échouent.

Symptômes observés, à reconnaître immédiatement s'ils reviennent :

- l'indicateur reste sur « Synchronisation… » pendant **environ deux minutes** —
  c'est le délai d'abandon de Firebase Storage, qui réessaie en boucle ;
- la console du navigateur répète
  `has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header`.

Le piège : côté JavaScript, un blocage CORS et une absence de réseau produisent
la **même** erreur, le navigateur refusant d'en dire plus. Le premier message
annonçait donc « Pas de réseau » alors que le réseau fonctionnait — de quoi
chercher des heures au mauvais endroit. `vaultSync.js` départage désormais les
deux avec `navigator.onLine` (`isOffline` contre `isBlocked`), et le message
nomme explicitement CORS.

Configuration faite pour `coffre-fort-test`, origines `http://localhost:5174` et
`http://127.0.0.1:5174`. Le fichier `cors.json` et la commande prête à coller
sont à la racine (`cors-commande.txt`). La manipulation passe par **Google Cloud
Shell**, pas par la console Firebase :
`https://shell.cloud.google.com/?project=coffre-fort-test`, puis
`gcloud storage buckets update gs://<bucket> --cors-file=cors.json`.

Deux détours à connaître pour ne pas les refaire :

- le sélecteur de projet de Google Cloud n'affiche que les projets **récents** ;
  passer à l'onglet « Tous », ou utiliser le lien direct ci-dessus ;
- **Brave bloque la console Google Cloud** (Shields). Page vide tant qu'on ne
  les désactive pas pour ce site.

### Mesure de volume — faite sur PC (2026-08-28)

Outil ajouté à `diagnostic.html`, section « Volume et performance » : il
fabrique un coffre rempli **en mémoire** (le vrai coffre n'est ni lu ni touché)
et chronomètre. Utilisable tel quel sur téléphone, sans transfert de fichier ni
fonction d'import.

PC de bureau, Argon2 **WebAssembly**, paramètres réels (64 Mio, 3 passes,
4 voies) :

| Entrées | Fichier | Enregistrement | Déverrouillage | Fusion seule |
|---|---|---|---|---|
| 1000 | 71,5 Ko | 988 ms | 941 ms | 8 ms |
| 2000 | 141,3 Ko | 1058 ms | 1004 ms | 11 ms |

**Ce que ça règle.** Le volume n'est pas un sujet : doubler le nombre d'entrées
double la taille mais n'ajoute que ~60 ms au déverrouillage. Argon2 est le coût
fixe et dominant (~900 ms), tout le reste est du bruit. La fusion est
négligeable — une dizaine de millisecondes.

**Corollaire à noter** : à ~71 Ko pour 1000 entrées, le coffre n'approche jamais
la limite Firestore de 1 Mo. La crainte qui avait fait écarter Firestore était
donc excessive à ce volume. Storage reste le bon choix — pas de découpage, pas
de base64, un seul objet opaque — mais si CORS devenait un jour bloquant, le
repli Firestore serait moins coûteux que prévu.

**Reste inconnu : le téléphone.** Argon2 y sera plusieurs fois plus lent. C'est
la seule mesure qui manque, et elle décide des paramètres du KDF.

### Corrigé au passage

`js/diagnostic.js` contenait quatre chaînes cassées — une apostrophe ASCII à
l'intérieur d'une chaîne délimitée par des apostrophes (lignes 272, 278, 282,
283). Le fichier ne se chargeait pas du tout ; le service worker servait une
version en cache, ce qui masquait entièrement la panne. À garder en tête :
**une page qui « marche » peut être servie par le cache alors que le fichier sur
disque est cassé.** En cas de doute, vider le cache et les service workers avant
de conclure.

La CSP de `diagnostic.html` a aussi reçu `'wasm-unsafe-eval'`, absent
jusqu'ici : sans lui la mesure serait tombée sur le repli JavaScript pur,
3,3 fois plus lent, donc non représentative de l'application réelle.

### Mesure sur téléphone — faite (2026-08-28)

iPhone, iOS 26.6, Chrome (CriOS 151), Argon2 **WebAssembly** confirmé :
**209 ms** aux paramètres réels (64 Mio, 3 passes, 4 voies).

Le même calcul coûte **~1220 ms** sur le PC de bureau. **Le téléphone est donc
environ cinq fois plus rapide que le PC** — l'inverse de ce qu'on attendait.
Argon2 est gourmand en mémoire, et la bande passante mémoire des puces Apple est
très supérieure. La conséquence pratique : l'appareil contraignant n'est pas le
téléphone mais le poste fixe.

**Décision : on ne touche pas aux paramètres du KDF.** L'appareil le plus lent
reste sous le seuil de 1,5 s. Si l'on voulait un jour durcir Argon2, c'est le PC
qui limiterait, pas le mobile.

Détail utile pour rejouer la mesure : sur une adresse réseau en `http://`
(192.168.x.x), seul Argon2 est mesurable. Le reste du coffre dépend de
`crypto.subtle`, que le navigateur réserve aux contextes sécurisés — kdbxweb y
échoue sur `a.randomBytes is not a function`, message qui n'apprend rien. La
page de diagnostic détecte désormais ce cas, l'explique, et se rabat sur la
mesure d'Argon2 seul, qui suffit puisqu'il représente l'essentiel du coût.

Un lien « Diagnostic de cet appareil » a été ajouté en bas de l'écran de
verrouillage : la page n'était atteignable qu'en tapant son adresse à la main,
peu praticable sur téléphone — or c'est là qu'elle doit servir.

### Phase 6 — sauvegarde indépendante (2026-08-28)

**Copies horodatées.** À chaque synchronisation réussie, le blob est aussi
déposé dans `users/{uid}/vault/history/{horodatage}.kdbx`, puis la rotation
s'applique. Écrit dans `js/vaultBackup.js` ; la décision de quoi garder vit
séparément dans `js/backupPolicy.js`, sans dépendance à Firebase, pour être
testable sous Node — même découpage que mergeCycle / vaultSync.

Politique retenue, schéma « grand-père, père, fils » :

| Fenêtre | Conservé |
|---|---|
| les plus récentes | 10, quoi qu'il arrive |
| 30 derniers jours | une par jour |
| 12 derniers mois | une par mois |

Deux propriétés de sûreté, testées explicitement : **la plus récente n'est
jamais supprimée**, et **un fichier au nom non reconnu n'est jamais touché** —
une sauvegarde déposée à la main dans ce dossier survit à la rotation.

Un défaut trouvé par les tests : `Date.UTC` accepte silencieusement un mois 13
ou un jour 45 et les reporte sur la date suivante. Un nom aberrant produisait
donc une date valide, et le fichier devenait supprimable. La reconnaissance se
fait maintenant par aller-retour — seul un nom que l'on sait reproduire est
accepté.

Coût : ~71 Ko la copie, une quarantaine de copies au régime établi, soit 3 Mo
sur les 5 Go gratuits. Une copie à chaque synchronisation reste très en dessous
des quotas d'opérations.

**Rappel d'export local.** Le bouton « Exporter le coffre » enregistre désormais
la date, et un rappel s'affiche au-dessus : discret quand la copie est récente,
en rouge s'il n'y en a jamais eu ou si elle date de plus de 30 jours. Raison
d'être : les copies horodatées vivent toutes chez le même hébergeur, sous le
même compte. Un compte fermé les emporterait ensemble. Un fichier sur disque est
la seule copie qui ne dépende de personne.

**Règles Storage à republier** dans les deux projets : le motif est passé de
`{fichier}` (un seul segment) à `{chemin=**}`, sans quoi le sous-dossier
`history/` ne serait pas autorisé. Le fichier `storage.rules` est à jour.

**Vérifié dans le navigateur** : rappel d'export dans ses deux états, export qui
enregistre la date, et dépôt réel d'une copie — le dossier `history/` apparaît
bien dans Storage avec un fichier horodaté après une synchronisation. La
rotation n'a pas pu être observée : elle ne supprime rien avant une dizaine de
copies.

### Le cache a masqué l'état réel du code trois fois

Chaque fois, la même illusion : la page « marchait » alors que le fichier sur
disque était différent de celui exécuté. `js/diagnostic.js` était cassé sans que
ça se voie, une section de `diagnostic.html` semblait absente, et un `app.js`
périmé a fait croire à un défaut inexistant.

Cause : `python -m http.server` envoie `Last-Modified` sans `Cache-Control`, ce
qui laisse le navigateur appliquer sa mise en cache heuristique.

Corrigé par `tools/serve.py`, qui sert tout avec `Cache-Control: no-store`, et
que `.claude/launch.json` utilise désormais. **Le port est passé à 5175** : le
cache est indexé par origine, et l'entrée empoisonnée du port 5174 restait
utilisée sans même une requête. Le service worker garde sa propre stratégie —
incrémenter `CACHE_NAME` dans `sw.js` reste nécessaire, comme en production.

Réflexe à garder : devant un comportement incohérent avec le code, vérifier
d'abord ce qui est réellement exécuté —
`performance.getEntriesByType('resource')` donne la taille reçue, et un
`transferSize` à zéro signale une réponse servie par un cache.

### Défaut trouvé et corrigé : écrasement silencieux d'un coffre

Découvert en vérifiant la phase 6, sur le projet de test — le coffre en ligne y
a été écrasé par un coffre vide, sans le moindre avertissement.

**Enchaînement.** La session Firebase est mémorisée **par origine**. En passant
de `localhost:5174` à `localhost:5175`, l'utilisateur n'était plus connecté.
`refreshLockScreen()` ne cherche le coffre distant que si `canSync()` est vrai,
donc seulement en étant connecté : l'application a proposé d'en créer un
nouveau. Une fois la connexion faite, la synchronisation a envoyé ce coffre vide
par-dessus l'autre.

**Pourquoi `merge()` n'a rien empêché.** Il suppose deux fichiers issus d'un
ancêtre commun. Deux coffres créés séparément n'en ont pas : leurs UUID de
groupes diffèrent, il n'y a rien à réconcilier, et le dernier envoi gagne.

Le même piège attend n'importe quel appareil neuf : créer un coffre avant de se
connecter est un geste naturel, et rien ne signalait le danger.

**Correctif.** `syncNow()` refuse désormais toute synchronisation automatique
quand le coffre local n'a jamais été synchronisé (`LAST_SYNC` et `EDIT_STATE`
tous deux absents) alors qu'un coffre distant existe. Elle lève `ConflitCoffre`,
qui porte les octets distants.

L'interface affiche alors un bloc rouge dans le coffre, la synchronisation reste
suspendue, et l'utilisateur tranche explicitement :

- **Utiliser le coffre en ligne** — repasse par l'écran de déverrouillage, car
  le coffre distant a sa propre phrase maîtresse et n'est installé qu'une fois
  celle-ci vérifiée ;
- **Remplacer le coffre en ligne** — `remplacerDistant()`, qui **dépose d'abord
  une copie horodatée de ce qui va être écrasé**, puis envoie le coffre local.

Les deux demandent confirmation. Aucune n'est automatique : les deux détruisent
quelque chose.

**Vérifié dans le navigateur** (2026-08-28) : le scénario reproduit — déconnexion,
`indexedDB.deleteDatabase('coffre_db')`, coffre recréé, reconnexion — fait bien
apparaître le bloc rouge, et la synchronisation reste suspendue au lieu
d'écraser. Reste non éprouvés : les deux boutons de résolution eux-mêmes.

Pour reproduire le conflit à volonté, c'est cette séquence-là.

### Déploiement — fait (2026-08-28)

Le site est en ligne : **https://tg24130.github.io/mysafer/**, dépôt public
`TG24130/mysafer`, GitHub Pages depuis la branche `main`, racine du dépôt.

Vérifié en production : pas de bandeau orange (le site parle bien au projet
`coffre-fort-ae72c`), connexion, création d'un coffre et synchronisation
réussie. La CORS du bucket de production a été posée sur l'origine
`https://tg24130.github.io`.

Points à connaître pour la suite :

- Le site est servi depuis un **sous-chemin** `/mysafer/`. Tous les chemins du
  projet sont relatifs, `start_url` et `scope` du manifeste compris — ne pas
  introduire de chemin absolu, il casserait le déploiement sans casser le
  développement local.
- **Une seule origine autorisée par bucket**, délibérément : la production
  n'accepte que le site déployé, le test n'accepte que le serveur local. Une
  session locale ne peut donc pas écrire dans le vrai coffre, même par erreur.
  Les commandes des deux projets sont dans `cors-commande.txt`.
- Vérifier la CORS d'un bucket en `curl` ne sert à rien : `firebasestorage`
  répond `Access-Control-Allow-Origin: *` de façon générique sur les chemins
  d'API, indépendamment de la configuration du bucket. Seul un essai depuis la
  vraie origine, dans un navigateur, tranche.
- Ni `gh` ni identité git globale sur ce poste. L'identité est posée au niveau
  du dépôt ; la création d'un dépôt passe par github.com, le serveur GitHub MCP
  étant en lecture seule.

### Reste à faire

**Aucune vraie donnée avant le point 1.** Il n'est pas négociable : c'est le
manquement exact qui a produit l'incident du 05/08/2026 sur Gestion Loc SCI,
où une fonctionnalité de synchronisation avait été mise au point sur des données
minuscules puis branchée directement sur le réel.

1. **CORS sur le bucket de PRODUCTION.** Pas encore fait, bloquant pour le
   déploiement. Même commande que pour le test, sur
   `gs://coffre-fort-ae72c.firebasestorage.app`, en remplaçant les origines
   localhost par l'adresse GitHub Pages réelle. Sans cela le site déployé
   restera bloqué deux minutes puis abandonnera, sans que rien dans la console
   Firebase ne l'explique.
2. **Déploiement HTTPS**, qui conditionne aussi la phase 5 : l'enrôlement
   WebAuthn devra être refait sur le domaine GitHub Pages, et un changement de
   domaine ultérieur casserait tous les enrôlements.

**Limite à assumer et déjà écrite dans le code** (`SYNC_LIMITS` dans
`js/mergeCycle.js`) : Firebase Storage n'a pas d'écriture conditionnelle. Deux
envois simultanés peuvent se perdre l'un l'autre. Fusionner-avant-d'envoyer rend
l'état convergent, pas transactionnel — d'où les copies horodatées de la phase 6.

### Confort à envisager

Effacer le coffre local n'est possible qu'en passant par la console du
navigateur (`indexedDB.deleteDatabase('coffre_db')`). `destroyLocalVault()`
existe dans `vaultDb.js` mais n'est branché sur aucun bouton. À exposer dans
l'interface, avec confirmation explicite.

### Écarté au passage

Remplacer Storage par Firestore pour rester sur le forfait gratuit. La solution
retenue dans Gestion Loc SCI — un document par fiche — ne se transpose pas ici :
le coffre est un fichier binaire chiffré unique, indécoupable sans casser le
format KDBX, donc sans casser la compatibilité KeePassXC (décision 1). Il
faudrait découper un blob base64 sur plusieurs documents, avec 33 % de
gonflement et des écritures non atomiques, c'est-à-dire retomber exactement
dans le terrain de l'incident d'août.

## Où on en est

| Phase | Contenu | État |
|---|---|---|
| 0 | Socle PWA, vendoring, vérifications de format | fait |
| 1 | Coffre local chiffré, hors ligne complet | fait |
| 2 | Répertoires, détail d'entrée, générateur, recherche | fait |
| 3 | Verrouillage 5 min, presse-papiers, Argon2 en worker | fait |
| 4 | Synchronisation Firebase Storage + fusion | fait |
| 5 | **Ouverture biométrique (WebAuthn PRF)** | **à faire — prochaine** |
| 6 | Sauvegarde indépendante | fait |
| 7 | Passe de design | à faire |

Plan complet : `~/.claude/plans/polymorphic-foraging-dolphin.md`
Recherche des briques : `../Quittance-Facile/.github-research/latest.md`

## Décisions arrêtées — ne pas rouvrir sans raison

1. **Format KDBX** (kdbxweb, MIT). Conséquence voulue : la saisie automatique
   navigateur n'est pas développée ici, l'utilisateur emploie KeePassXC ou
   KeePassDX sur le même fichier.
2. **Synchronisation à l'ouverture et à la sauvegarde**, pas de push temps réel.
3. **Usage personnel / cercle restreint.** Perte de la phrase maîtresse = coffre
   perdu, assumé. Pas de récupération de compte, pas de RGPD à documenter.
4. **Biométrie activée + phrase de 6 mots** (77,5 bits, liste EFF). Arbitrage :
   durcir Argon2 rapporte ~3 bits, ajouter un mot en rapporte 12,9. La biométrie
   est ce qui rend une phrase longue tenable au quotidien.
5. **Liste de mots en anglais**, délibérément. Les mots français portent des
   accents, qui se tapent différemment selon le clavier — risque réel pour un
   secret sans récupération. Aucune liste française crédible trouvée sur npm.
6. **Application et projet Firebase séparés** de Gestion Loc SCI. Une XSS dans
   les 7321 lignes de `webapp/js/app.js` ne doit pas atteindre les mots de passe.

## Faits mesurés — ne pas les re-dériver

- **Argon2id 64 Mio / 3 passes / 4 voies, PC de bureau** : WebAssembly
  ~1220 ms, de façon constante. Mesuré le 2026-08-28 sur trois appels
  consécutifs dans le même worker : 1211, 1234, 1224 ms.
  **Correction d'un fait consigné le 2026-08-26**, qui annonçait « ~1250 ms à
  froid puis ~230 ms ensuite » : cette accélération n'existe pas, le coût est
  identique à chaque appel. La mesure initiale devait porter sur des paramètres
  différents. Le repli JavaScript pur reste environ 3 fois plus lent.
- **kdbxweb divise la mémoire par 1024 avant d'appeler l'implémentation Argon2.**
  L'argument reçu est déjà en kibioctets. Ne pas reconvertir.
- **`argon2-browser` code `version = 0x13` en dur** et n'accepte pas le
  paramètre. Un coffre en version 0x10 lui donnerait un hash faux, donc un
  « mot de passe incorrect » sur une phrase juste. D'où le repli `@noble/hashes`.
- **`@xmldom/xmldom` est du code mort côté navigateur** : `createDOMParser()`
  teste `globalThis.DOMParser` en premier. Sous Node en revanche, kdbxweb exige
  `@xmldom/xmldom` **0.8.x** — la 0.9 a supprimé l'option `errorHandler`.
- **WebAssembly exige `'wasm-unsafe-eval'` dans la CSP.** Directive bien plus
  étroite que `'unsafe-eval'`.
- **Écrire dans le presse-papiers exige un geste utilisateur récent**, même avec
  la permission `clipboard-write` à `granted` et le document focalisé. Une purge
  par simple `setTimeout` ne s'exécute jamais.
- **PRF WebAuthn validé sur le PC** (Chrome 151, Windows) : déterministe,
  32 octets. Le `rpId` du test était `localhost` ; l'enrôlement réel devra se
  refaire sur le domaine GitHub Pages, et un changement de domaine casserait
  tous les enrôlements.
- **Le service worker ignore tout ce qui est cross-origin.** Toute dépendance
  nécessaire au déverrouillage doit être vendorée, sinon le mode hors ligne
  casse.

## Vérifications manuelles en attente

1. **Test du presse-papiers**, en bas de `diagnostic.html`, avec un vrai clic
   dans Edge ou Chrome — pas dans le panneau navigateur de l'application, qui
   est un Electron embarqué. Purement informatif, ne bloque rien.
2. ~~Ouvrir un `.kdbx` exporté dans KeePassXC.~~ **Fait le 2026-08-28.**
   KeePassXC 2.x sur Windows ouvre un export de production : dérivation Argon2,
   répertoires, entrée et **mot de passe protégé** tous corrects. C'est une base
   de code qui ne partage rien avec kdbxweb — l'interopérabilité du format n'est
   donc plus une hypothèse.
   Note pratique : lancé depuis un script, KeePassXC s'ouvre parfois derrière la
   fenêtre active et paraît inerte. `keepassxc-cli show -s <fichier> <titre>`
   donne la même preuve sans interface.
3. **Diagnostic PRF sur le téléphone**, après le premier déploiement HTTPS.
   `http://192.168.x.x` échouera toujours : WebAuthn exige un contexte sécurisé.
   La page se rejoint depuis le lien « Diagnostic de cet appareil », en bas de
   l'écran de verrouillage.

## État de confiance

Le coffre est **en service réel** et vérifié de bout en bout : synchronisation
multi-appareils, copies horodatées avec rotation, garde-fou contre l'écrasement,
export local avec rappel, et interopérabilité KeePassXC prouvée.

Deux réserves demeurent, de nature différente.

**Perdre la phrase maîtresse reste sans recours** (décision 3). Aucune
récupération n'existe, ni ici ni ailleurs. C'est le prix assumé de l'absence de
tiers de confiance.

**Les copies en ligne dépendent toutes d'un seul compte Google.** Un compte
fermé ou suspendu les emporterait ensemble. L'export sur disque est la seule
copie qui n'en dépende pas — d'où le rappel tous les trente jours, qu'il vaut
mieux ne pas ignorer.

