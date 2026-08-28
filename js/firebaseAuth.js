// Authentification Firebase (e-mail + mot de passe).
//
// Ce mot de passe n'est PAS la phrase maîtresse du coffre. Il ne sert qu'à
// prouver au serveur de quel utilisateur on est, donc à quel dossier Storage
// on a droit. Le contenu du coffre est chiffré avant l'envoi : Firebase ne
// stocke qu'un blob illisible, et connaître ce mot de passe ne permet pas de
// l'ouvrir.
//
// Le SDK est vendoré : voir l'explication dans firebaseInit.js.
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from './vendor/firebase/firebase-auth.js';
import { firebaseApp } from './firebaseInit.js';

const auth = getAuth(firebaseApp);

// `resolved` passe à true dès que Firebase a tranché sur la session en cours.
// Un abonné arrivé après cette résolution ne recevrait jamais l'événement : on
// mémorise donc l'état pour le lui rejouer immédiatement.
export const authState = {
  currentUser: null,
  resolved: false,
};

const subscribers = new Set();

onAuthStateChanged(auth, (user) => {
  authState.currentUser = user;
  authState.resolved = true;
  subscribers.forEach((fn) => fn(user));
});

// Renvoie une fonction de désabonnement. Si l'état est déjà connu au moment de
// l'abonnement, le callback est appelé tout de suite.
export function onAuthChange(callback) {
  subscribers.add(callback);
  if (authState.resolved) callback(authState.currentUser);
  return () => subscribers.delete(callback);
}

export function signIn(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export function signOutUser() {
  return signOut(auth);
}

// Identifiant du compte connecté, ou null. C'est la clé du chemin Storage
// `users/{uid}/vault/db.kdbx`.
export function currentUid() {
  return authState.currentUser ? authState.currentUser.uid : null;
}
