// Initialisation Firebase partagée. Importée par firebaseAuth.js et
// vaultSync.js : initializeApp ne peut être appelé qu'une seule fois par
// configuration, tout passe donc par ce module.
//
// Le SDK est vendoré dans js/vendor/firebase/ et non chargé depuis
// www.gstatic.com. Deux raisons : la CSP de ce projet interdit tout script
// hors origine (`script-src 'self'`), et le service worker ignore
// délibérément le cross-origin, si bien qu'une dépendance servie par un CDN
// ne serait jamais mise en cache.
import { initializeApp } from './vendor/firebase/firebase-app.js';

// Ces valeurs ne sont pas des secrets : elles sont visibles dans le code de
// toute application web. La protection réelle vient des règles de sécurité
// Storage, qui restreignent chaque utilisateur à son propre dossier.

// Projet de PRODUCTION : le vrai coffre. Le nom « coffre-fort » était déjà
// pris, d'où le suffixe ajouté par Firebase.
const PROD_CONFIG = {
  apiKey: 'AIzaSyB6m2yV6hwfFgrCOBBPm_bMoGmQERceJYk',
  authDomain: 'coffre-fort-ae72c.firebaseapp.com',
  projectId: 'coffre-fort-ae72c',
  storageBucket: 'coffre-fort-ae72c.firebasestorage.app',
  messagingSenderId: '154169435805',
  appId: '1:154169435805:web:778cc6de4ad065cf4a1674',
};

// Projet de TEST : coffres jetables, sert à valider avant tout déploiement.
const TEST_CONFIG = {
  apiKey: 'AIzaSyAYF-m-P8yCsK2zAor2mQaxjxx8wl7Z8n0',
  authDomain: 'coffre-fort-test.firebaseapp.com',
  projectId: 'coffre-fort-test',
  storageBucket: 'coffre-fort-test.firebasestorage.app',
  messagingSenderId: '767920379802',
  appId: '1:767920379802:web:ff3ba48c9933cf54a84c23',
};

// Le choix du projet est déduit de l'adresse, jamais d'un réglage manuel : une
// session locale ne peut donc pas structurellement écrire dans le vrai coffre,
// même par erreur. Seul le site déployé parle à la production.
// (Leçon de l'incident du 05/08/2026 sur Gestion Loc SCI : la migration avait
// été mise au point directement contre le projet de production.)
export function isDevHost(hostname) {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === ''                       // fichier ouvert en local (file://)
    || /^192\.168\./.test(hostname)          // réseau local (test depuis le téléphone)
    || /^10\./.test(hostname)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
}

export const IS_TEST_ENV = isDevHost(location.hostname);

const firebaseConfig = IS_TEST_ENV ? TEST_CONFIG : PROD_CONFIG;

export const PROJECT_ID = firebaseConfig.projectId;
export const firebaseApp = initializeApp(firebaseConfig);

// Repère visuel permanent en environnement de test : impossible de confondre
// une fenêtre de test avec le vrai coffre pendant un dépannage.
// Les styles sont posés via la CSSOM, que la CSP ne restreint pas ; le bandeau
// reste donc visible même si la feuille de style ne se charge pas.
if (IS_TEST_ENV) {
  const badge = document.createElement('div');
  badge.textContent = `PROJET DE TEST — ${firebaseConfig.projectId}`;
  badge.setAttribute('role', 'status');
  badge.style.cssText = [
    'position:fixed', 'z-index:99999', 'left:0', 'right:0', 'bottom:0',
    'background:#F0A500', 'color:#16191C', 'text-align:center',
    'font:600 12px/1.6 system-ui,sans-serif', 'letter-spacing:.04em',
    'padding:4px 8px', 'pointer-events:none',
  ].join(';');
  // Réserver la hauteur du bandeau : posé en `fixed`, il recouvrait la barre
  // de modes du coffre, donc des commandes réelles.
  // On publie la hauteur du bandeau plutôt que de rembourrer <body> : les
  // écrans font 100dvh, et un rembourrage sur le parent les faisait déborder
  // d'autant — la barre de modes se retrouvait rognée.
  const attach = () => {
    if (!document.body) return;
    document.body.appendChild(badge);
    document.documentElement.style.setProperty('--badge-h', badge.offsetHeight + 'px');
  };
  if (document.body) attach();
  else document.addEventListener('DOMContentLoaded', attach, { once: true });
}
