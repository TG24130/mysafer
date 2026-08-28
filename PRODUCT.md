# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Utilisateur principal :** Thierry, propriétaire du produit, qui l'a commandé
et le fait évoluer. Il connaît le fonctionnement interne.

**Utilisateurs secondaires confirmés :** ses proches — conjoint, enfants,
parents. Chacun a son propre compte et son propre coffre ; personne ne partage
de données avec un autre. Conséquence déterminante : **ils s'en serviront sans
que Thierry soit derrière leur épaule.** Rien ne peut donc reposer sur une
explication orale, et un premier démarrage doit se comprendre seul.

**Situation dominante d'usage : le téléphone, en mobilité.** Debout, une seule
main, parfois pressé. La tâche typique est de retrouver une entrée et d'en
copier le mot de passe. L'usage au PC existe mais n'est pas la référence de
conception.

## Product Purpose

Conserver des mots de passe personnels sans confier sa sécurité à un tiers.

Le contenu est chiffré sur l'appareil avant tout envoi : l'hébergeur ne stocke
qu'un fichier illisible. Le coffre s'ouvre et s'utilise hors ligne. La
synchronisation permet de retrouver le même coffre sur ses appareils.

Le succès se mesure à une chose : que l'utilisateur y range ses vrais mots de
passe et cesse de les retenir de tête ou de les réutiliser.

## Positioning

**Le fichier appartient à l'utilisateur, et reste lisible sans nous.** Le format
est KDBX 4.0, ouvrable par KeePassXC sur PC et KeePassDX sur Android —
vérifié, pas supposé. Un gestionnaire commercial ne peut pas honnêtement en
dire autant : sa base n'existe que dans son écosystème.

**Aucun tiers de confiance, et aucune récupération.** Perdre la phrase maîtresse
signifie perdre le coffre. C'est un choix assumé, contrepartie du fait que
personne d'autre ne peut le lire.

## Operating Context

- Application web installable, ouverte depuis le navigateur ou l'écran
  d'accueil. Déployée sur GitHub Pages, servie depuis un sous-chemin.
- Deux environnements étanches, choisis d'après l'adresse : le site déployé
  parle au projet Firebase de production, une session locale au projet de test.
- La synchronisation se déclenche à l'ouverture du coffre et après chaque
  enregistrement, en arrière-plan, sans jamais bloquer l'enregistrement local.
- Le coffre se verrouille après cinq minutes d'inactivité, et à tout
  rechargement de page — la clé ne vit qu'en mémoire.
- L'ouverture biométrique s'enrôle par appareil et par navigateur, jamais
  transférable.

## Capabilities and Constraints

**Fonctions confirmées :** création et ouverture d'un coffre chiffré,
répertoires, entrées avec titre / identifiant / mot de passe / adresse / notes,
recherche, génération de phrases et de mots de passe, copie avec effacement
différé du presse-papiers, verrouillage automatique, synchronisation avec
fusion multi-appareils, copies horodatées avec rotation, export du fichier,
ouverture biométrique.

**Contraintes techniques durables :**

- Pas d'outil de construction, pas de framework : HTML, CSS et JavaScript
  servis tels quels. Toute dépendance est copiée dans `js/vendor/`.
- **CSP stricte : aucun style ni script en ligne, aucune origine externe.** Cela
  interdit les attributs `style`, les balises `<style>`, et tout chargement
  depuis un CDN — polices comprises.
- Le déverrouillage doit fonctionner **hors ligne**. Toute ressource nécessaire
  à l'ouverture doit être servie depuis la même origine, sinon le service
  worker ne la met pas en cache.
- L'application est servie depuis un sous-chemin : **aucun chemin absolu**.
- Argon2id 64 Mio / 3 passes / 4 voies. Mesuré : 209 ms sur iPhone, ~1,2 s sur
  PC de bureau.

**Vocabulaire de l'application**, à conserver : coffre, phrase de passe
maître (distincte du mot de passe du compte de synchronisation), répertoire,
entrée.

## Brand Commitments

**Nom du produit : MySafer.** L'interface affichait « Coffre » ; le nom retenu
est celui du dépôt. Le vocabulaire courant reste français.

Aucun logo, aucune charte, aucune police imposée à ce jour.

## Evidence on Hand

- Application déployée et en service réel : `https://tg24130.github.io/mysafer/`
- Interopérabilité KeePassXC **vérifiée** le 2026-08-28 sur un export de
  production : dérivation, répertoires, entrées et champs protégés corrects.
- Mesures de performance réelles, PC et iPhone, consignées dans `REPRISE.md`.
- 94 tests automatisés (`npm test`).
- Aucun témoignage, aucun client, aucun chiffre d'usage : ce produit n'a pas
  d'existence commerciale et rien de tel ne doit être inventé.

## Product Principles

1. **Le coffre local prime sur le réseau.** Un échec de synchronisation n'est
   jamais un échec d'enregistrement, et doit se voir sans inquiéter.
2. **Ne jamais retirer le chemin manuel.** La biométrie, la synchronisation et
   l'installation sont des conforts ; la phrase maîtresse et le fichier exporté
   restent toujours accessibles.
3. **Dire la vérité sur ce qui s'est produit.** Un effacement de presse-papiers
   qui échoue, une synchronisation suspendue, une sauvegarde manquante : tout
   cela s'affiche tel quel plutôt que d'être masqué.
4. **Une action destructrice se choisit, jamais ne se subit.** Aucune fusion,
   aucun écrasement, aucune suppression automatique sans décision explicite.
5. **L'écran doit mettre en avant l'action juste selon la situation.** Proposer
   d'abord la mauvaise finit par la faire commettre — c'est arrivé deux fois
   avec la création de coffre sur un appareil neuf.

## Accessibility & Inclusion

Contrainte relevée à l'usage : **la saisie d'une phrase de six mots sur le
clavier d'un téléphone est source d'erreurs répétées.** Ce constat a motivé
l'ouverture biométrique, et doit continuer de guider toute conception qui
imposerait une saisie longue sur petit écran.

Cibles tactiles larges et atteignables au pouce, l'usage de référence étant le
téléphone tenu d'une seule main.
