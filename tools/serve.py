"""Serveur de développement, sans cache.

Pourquoi ce fichier existe plutôt qu'un simple `python -m http.server` :
celui-ci renvoie `Last-Modified` sans `Cache-Control`, ce qui laisse le
navigateur appliquer sa mise en cache heuristique. Un fichier modifié continue
alors d'être servi depuis le cache, et l'on croit tester le nouveau code alors
qu'on exécute l'ancien.

Ça nous a coûté trois fausses pistes le 2026-08-28 : une erreur de syntaxe dans
diagnostic.js masquée par le cache du service worker, une section HTML absente
de la page servie, et un module app.js périmé qui faisait croire à un défaut
inexistant.

Ici tout est renvoyé avec `Cache-Control: no-store`. Le service worker de
l'application continue de fonctionner normalement — sa propre stratégie de cache
reste testable, il suffit d'incrémenter CACHE_NAME dans sw.js comme en
production.

Usage :  python tools/serve.py [port]
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent


class SansCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Le journal par défaut noie les erreurs sous les 200. On ne garde que
        # ce qui signale un problème.
        code = args[1] if len(args) > 1 else ""
        if str(code).startswith(("4", "5")):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5174
    handler = partial(SansCache, directory=str(RACINE))
    # 0.0.0.0 et non localhost : le téléphone doit pouvoir joindre le serveur
    # sur le réseau local pour la page de diagnostic.
    serveur = ThreadingHTTPServer(("0.0.0.0", port), handler)
    print(f"Coffre servi sur http://localhost:{port} (sans cache)")
    print("Depuis le téléphone : http://<adresse-locale-du-PC>:%d" % port)
    try:
        serveur.serve_forever()
    except KeyboardInterrupt:
        print("\nArrêt.")


if __name__ == "__main__":
    main()
