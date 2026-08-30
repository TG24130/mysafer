# Reprise de session — MySafer

Dernière session : **2026-08-29**.

À lire en premier au démarrage d'une session. Ce fichier dit **l'état, les
décisions et les pièges** — pas l'histoire de leur découverte. Le détail
technique est dans `README.md`, la vérité produit dans `PRODUCT.md`.

---

## Ouvrir la session au bon endroit

Répertoire de travail : `C:\Users\greni\Desktop\Dossiers CLAUDE\MySafer`.

Le projet s'appelait « Coffre-Fort » et vivait sur le bureau ; déplacé et
renommé le 2026-08-28, quand le produit a pris le nom MySafer.

```bash
python tools/serve.py 5175
```

**Ne pas revenir à `python -m http.server`** : il laisse le navigateur mettre
les fichiers en cache et fait tester du code périmé. Le cache a masqué l'état
réel du code trois fois en une journée.

```bash
npm test
```

Six suites, **96 tests**. Site en ligne : **https://tg24130.github.io/mysafer/**
Dépôt public `TG24130/mysafer`, GitHub Pages depuis `main`, racine.

---

## Où on en est

| Phase | Contenu | État |
|---|---|---|
| 0 | Socle PWA, vendoring, vérifications de format | fait |
| 1 | Coffre local chiffré, hors ligne complet | fait |
| 2 | Répertoires, détail d'entrée, générateur, recherche | fait |
| 3 | Verrouillage 5 min, presse-papiers, Argon2 en worker | fait |
| 4 | Synchronisation Firebase Storage + fusion | fait |
| 5 | Ouverture biométrique (WebAuthn PRF) | fait, éprouvé sur iPhone |
| 6 | Sauvegarde indépendante | fait |
| 7 | Passe de design | fait |

**Le coffre est en service réel.** Synchronisé, sauvegardé par copies
horodatées, protégé contre l'écrasement, exportable, et lisible par KeePassXC —
vérifié, pas supposé.

Ajouts postérieurs aux phases : suppression d'entrée et de répertoire par
balayage, réordonnancement au doigt, adresse postale dans la fiche, icône,
bouton « Trier » qui réécrit l'ordre alphabétique une bonne fois, duplication
d'entrée vers le répertoire choisi, import d'un `.kdbx` (l'export n'avait pas
de symétrique : la sauvegarde n'était restaurable que dans KeePassXC), mode
d'emploi imprimable dans `docs/`.

---

## Reste à faire

1. **Vérifier la suppression de répertoire sur un vrai appareil.** Écrite et
   publiée, syntaxe et tests au vert, mais jamais exécutée : le panneau
   navigateur s'est mis à bloquer toutes les ressources locales en fin de
   session. C'est le seul point non éprouvé du projet.
2. **Effacer le coffre local** n'est possible que par la console du navigateur
   (`indexedDB.deleteDatabase('coffre_db')`). `destroyLocalVault()` existe dans
   `vaultDb.js` mais n'est branché sur aucun bouton.
3. **Vérifications manuelles en attente** : ouvrir un `.kdbx` exporté dans
   **KeePassDX sur Android** (KeePassXC est fait, sur PC), et lancer le
   diagnostic PRF sur d'autres appareils avant de les enrôler.
4. **Le tri ne concerne que les entrées.** Les répertoires se rangent au doigt,
   sans bouton. Le mécanisme serait le même si le besoin apparaît.

---

## Décisions arrêtées — ne pas rouvrir sans raison

1. **Format KDBX 4.0** (kdbxweb, MIT). Conséquence voulue : pas de saisie
   automatique navigateur ici, l'utilisateur emploie KeePassXC ou KeePassDX sur
   le même fichier.
2. **Synchronisation à l'ouverture et à l'enregistrement**, jamais en temps réel.
3. **Usage personnel et cercle restreint.** Perte de la phrase maîtresse =
   coffre perdu, assumé. Aucune récupération de compte, pas de RGPD à documenter.
4. **Biométrie + phrase de 6 mots** (77,5 bits, liste EFF). Durcir Argon2
   rapporte ~3 bits, ajouter un mot en rapporte 12,9. La biométrie est ce qui
   rend une phrase longue tenable au quotidien.
5. **Liste de mots en anglais**, délibérément : les mots français portent des
   accents, qui se tapent différemment selon le clavier — risque réel pour un
   secret sans récupération.
6. **Projet Firebase séparé** de Gestion Loc SCI. Une XSS dans les 7321 lignes
   de `webapp/js/app.js` ne doit pas atteindre les mots de passe.
7. **Storage plutôt que Firestore.** Le coffre est un fichier binaire chiffré
   unique, indécoupable sans casser KDBX. Nuance mesurée depuis : à ~71 Ko pour
   1000 entrées, la limite Firestore de 1 Mo n'était pas si proche — un repli
   resterait possible si CORS devenait bloquant.
8. **Le nom du produit est MySafer.** Vocabulaire français conservé : coffre,
   phrase de passe maître, répertoire, entrée.

---

## Architecture — le découpage qui compte

La règle qui gouverne tout : **ce qui est délicat ne doit dépendre ni du
navigateur ni du réseau, pour être testable sous Node.**

| Module | Rôle | Testable |
|---|---|---|
| `vaultModel.js` | lecture du contenu, fonctions pures | oui (28) |
| `generator.js` | génération de secrets | oui (20) |
| `lockTimer.js` | inactivité, visibilité | oui (18) |
| `mergeCycle.js` | cycle de fusion, transport injecté | oui (10) |
| `backupPolicy.js` | rétention des copies | oui (12) |
| `keyWrap.js` | emballage de la phrase, secret injecté | oui (8) |
| `dragOrder.js` | réordonnancement au doigt | non (DOM) |
| `vaultSync.js` | transport Firebase Storage | non |
| `vaultBackup.js` | copies horodatées | non |
| `deviceKey.js` | plomberie WebAuthn | non |
| `syncController.js` | assemble les quatre précédents | non |
| `app.js` | DOM et enchaînement | non |

`vaultCrypto.js` est le seul point de contact avec kdbxweb et Argon2.

---

## Pièges qui ont coûté du temps — ne pas y retomber

### Le cache masque l'état réel du code

Trois fois en une journée : une erreur de syntaxe invisible, une section HTML
absente de la page servie, un module périmé qui a fait chercher un bug
inexistant. Devant un comportement incohérent avec le code, **vérifier d'abord
ce qui est réellement exécuté** : `performance.getEntriesByType('resource')`
donne la taille reçue, et un `transferSize` à zéro signale une réponse servie
par un cache. `tools/serve.py` répond en `no-store` ; le service worker garde sa
propre stratégie, donc incrémenter `CACHE_NAME` reste nécessaire à chaque
modification.

### CORS : l'autorisation invisible

Firebase Storage exige que l'origine du site soit autorisée **sur le bucket
lui-même** — distinct des règles de sécurité, absent de la console Firebase.
Symptômes : l'indicateur reste sur « Synchronisation… » environ deux minutes,
puis abandonne ; la console répète `blocked by CORS policy`.

Piège dans le piège : côté JavaScript, un blocage CORS et une absence de réseau
produisent la **même** erreur. `vaultSync.js` les départage avec
`navigator.onLine` (`isOffline` contre `isBlocked`).

Se configure dans **Google Cloud Shell**, pas dans Firebase — commandes prêtes
dans `cors-commande.txt`. Deux détours : le sélecteur de projet Google Cloud
n'affiche que les projets récents, et **Brave bloque la console Google Cloud**
(Shields). Vérifier en `curl` ne sert à rien : `firebasestorage` répond
`Allow-Origin: *` de façon générique sur les chemins d'API. Seul un essai depuis
la vraie origine tranche.

### kdbxweb ne met pas à jour `lastModTime`

C'est à l'appelant d'appeler `entry.times.update()` après toute modification.
Sans cela, deux appareils divergent **en silence et définitivement**. C'est la
panne la plus dangereuse du lot.

### Les horodatages KDBX ont une résolution d'une seconde

Un test qui s'exécute d'un trait fait tout tomber dans la même seconde : les
temps sont à égalité, la fusion ne peut pas trancher, et la divergence paraît
permanente. Les tests datent donc tout explicitement.

### Un fichier n'est installé qu'une fois sa phrase acceptée

L'import de `.kdbx` ne réécrit rien lui-même : il pose les octets dans
`octetsAInstaller`, verrouille, et laisse l'écran de déverrouillage faire le
travail — le même chemin que la récupération d'un coffre en ligne sur un
appareil neuf. `adoptRemoteVault()` n'écrit dans IndexedDB qu'après une
ouverture réussie, et retire l'enrôlement biométrique, qui emballait l'ancienne
phrase. Une phrase erronée, un fichier illisible ou un rechargement en cours de
route laissent donc le coffre existant intact.

Toute nouvelle façon d'installer un coffre doit passer par là plutôt que
d'appeler `saveVaultBytes()` directement.

### La corbeille est un sous-groupe comme un autre

`flattenGroups` et `allEntries` l'excluaient ; `entriesOf` non — elle descendait
dans tous les sous-groupes. Comme la corbeille est fille de la racine, une
entrée supprimée y restait comptée : le répertoire racine annonçait `3` avec une
liste vide ailleurs, et cliquer dessus la faisait réapparaître, sous-titrée
« Recycle Bin ». La re-supprimer ne faisait rien — elle était déjà à la
corbeille. Vu de l'utilisateur : « la suppression ne prend pas ».

Le coffre est désormais le **premier** argument de `entriesOf(db, group,
recursive)`, obligatoire, pour que l'exclusion ne puisse plus être oubliée à
l'appel. Toute nouvelle fonction qui parcourt les sous-groupes doit se poser la
question.

### Autres pièges de code

- **`String()` sur un champ protégé** renvoie la forme chiffrée, différente à
  chaque appel. Seul `getText()` donne le contenu.
- **Une suppression KDBX est un déplacement daté vers la corbeille**, pas un
  effacement. C'est `locationChanged` qui arbitre.
- **`[hidden]` perd contre `display: flex`.** La feuille impose donc
  `[hidden] { display: none !important; }`.
- **Un élément de grille garde `min-width: auto`** et refuse de rétrécir sous
  son contenu : les lignes d'entrée débordaient de 67 px hors de l'écran.
- **Une promesse rejetée non traitée rend un bouton inerte, sans message.**
  `app.js` écoute désormais `unhandledrejection` et l'affiche.

---

## Faits mesurés — ne pas les re-dériver

**Argon2id 64 Mio / 3 passes / 4 voies, WebAssembly :**

| Appareil | Temps |
|---|---|
| iPhone (iOS 26.6) | **209 ms** |
| PC de bureau | **~1220 ms**, constant |

**Le téléphone est cinq fois plus rapide que le PC** — l'inverse de l'attendu.
L'appareil contraignant est donc le poste fixe, et il reste sous le seuil de
1,5 s. **Les paramètres du KDF ne bougent pas.**

**Volume**, paramètres réels :

| Entrées | Fichier | Enregistrement | Déverrouillage | Fusion |
|---|---|---|---|---|
| 1000 | 71,5 Ko | 988 ms | 941 ms | 8 ms |
| 2000 | 141,3 Ko | 1058 ms | 1004 ms | 11 ms |

Doubler les entrées double la taille mais n'ajoute que ~60 ms. Argon2 est le
coût fixe et dominant ; la fusion est négligeable.

**Autres faits :**

- **kdbxweb divise la mémoire par 1024** avant d'appeler Argon2 : l'argument
  reçu est déjà en kibioctets. Ne pas reconvertir.
- **`argon2-browser` code `version = 0x13` en dur.** Un coffre en 0x10 lui
  donnerait un hash faux, donc un « mot de passe incorrect » sur une phrase
  juste. D'où le repli `@noble/hashes`.
- **`@xmldom/xmldom` est du code mort côté navigateur**, mais kdbxweb l'exige
  sous Node en **0.8.x** (la 0.9 a supprimé `errorHandler`). npm signale des
  failles sur cette version : contrainte assumée, jamais déployée.
- **WebAssembly exige `'wasm-unsafe-eval'`** dans la CSP — bien plus étroit que
  `'unsafe-eval'`.
- **Écrire dans le presse-papiers exige un geste utilisateur récent.** Une purge
  par simple `setTimeout` ne s'exécute jamais.
- **Le service worker ignore tout ce qui est cross-origin.** Toute dépendance
  nécessaire au déverrouillage doit être vendorée.
- **`setLocalEditState` n'a aucun effet observable** sur les scénarios couverts,
  redémarrage compris — vérifié avec et sans. Conservé (marche à suivre
  kdbxweb, coût nul) ; un test fige le constat.
- **Hors contexte sécurisé, `crypto.subtle` est absent** : kdbxweb échoue sur
  `a.randomBytes is not a function`. Sur `http://192.168.x.x`, seul Argon2 est
  mesurable — ce que la page de diagnostic fait.

---

## Configuration Firebase

| | Production | Test |
|---|---|---|
| `projectId` | `coffre-fort-ae72c` | `coffre-fort-test` |
| Origine CORS | `https://tg24130.github.io` | `http://localhost:5175` |

Ces valeurs ne sont pas des secrets : visibles dans le code de toute application
web. La protection vient des règles Storage (`storage.rules`), qui restreignent
chaque utilisateur à `users/{uid}/vault/`.

Blaze obligatoire depuis le 03/02/2026 pour tout nouveau bucket. Quotas gratuits
inchangés, usage réel très loin des seuils. Région **US** assumée : le contenu
est chiffré, Google ne stocke qu'un blob illisible.

**Une seule origine autorisée par bucket, délibérément** : la production
n'accepte que le site déployé, le test que le serveur local. Une session locale
ne peut donc pas écrire dans le vrai coffre, même par erreur.

---

## Le monde visuel — instrument de bureau

Direction retenue par l'utilisateur contre l'assignation du tirage (seed
`660b8c59`). Le contrat complet est en commentaire HTML en tête de `<body>` dans
`index.html` ; **le lire avant toute modification d'interface.**

**Une seule gravure garde sa casse : le nom du produit.** « MySafer » est un
nom propre, pas une légende ; il est donc en casse mixte et resserré, quand
toutes les autres gravures restent en capitales très espacées.

**Loi de couleur, non négociable : ambre = état, orange = geste qui commet.**
Un orange qui ne commet rien est un défaut ; un état peint en orange aussi.

Deux règles de fabrication : les surfaces de lecture sont claires et la
structure sombre (l'usage de référence est le téléphone en plein jour) ; relief
franc et jamais d'ombre douce.

Aucune police externe — la CSP interdit toute origine tierce.

**Le détecteur relève les bordures colorées à gauche** comme tell générique. Le
dispositif d'état de ce monde est l'écran encastré, et l'annonciateur cerclé.
Attention : un liseré posé en ombre interne échappe au détecteur mais reste le
même tic.

Vérifier après toute retouche :

```bash
node C:/Users/greni/.claude/skills/impeccable/scripts/detect.mjs --json index.html css/style.css js/app.js
```

Il tourne **dégradé** ici (modules d'analyse HTML absents) : il ne voit ni les
variables CSS ni les contrastes calculés. Un zéro n'est pas un quitus.

---

## Avertissement permanent

**Perdre la phrase maîtresse reste sans recours.** Aucune récupération n'existe,
ni ici ni ailleurs. C'est le prix assumé de l'absence de tiers de confiance.

**Les copies en ligne dépendent toutes d'un seul compte Google.** Un compte
fermé les emporterait ensemble. L'export sur disque est la seule copie qui n'en
dépende pas — d'où le rappel tous les trente jours, qu'il vaut mieux ne pas
ignorer.

**Firebase Storage n'a pas d'écriture conditionnelle** (`SYNC_LIMITS` dans
`mergeCycle.js`). Deux envois simultanés peuvent se perdre l'un l'autre.
Fusionner-avant-d'envoyer rend l'état convergent, pas transactionnel — d'où les
copies horodatées.
