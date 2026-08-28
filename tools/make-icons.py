"""Génère les icônes de MySafer.

Le motif est celui du produit lui-même, réduit à l'os : deux touches claires
empilées sur le châssis gunmetal, et la touche orange qui copie à droite de la
première. C'est exactement ce qu'on voit dans la liste des entrées — donc
l'icône annonce ce qu'on va trouver, au lieu d'un cadenas générique.

Pourquoi un script plutôt que des fichiers déposés : les couleurs sont celles
de css/style.css. Si le monde visuel change, on relance et tout suit. Un PNG
dessiné à la main dérive sans que personne s'en aperçoive.

Rendu à 4× puis réduit : le seul anticrénelage dont on ait besoin, sans
dépendance supplémentaire.

Usage :  python tools/make-icons.py
"""

from pathlib import Path
from PIL import Image, ImageDraw

RACINE = Path(__file__).resolve().parent.parent
DEST = RACINE / "icons"

# Matériaux, repris de css/style.css.
CHASSIS = (0x22, 0x26, 0x2B, 255)
CHASSIS_DEEP = (0x16, 0x19, 0x1C, 255)
CAP = (0xE9, 0xE3, 0xD5, 255)
CAP_HI = (0xF7, 0xF3, 0xE9, 255)
CAP_LO = (0xB3, 0xAC, 0x9A, 255)
INK = (0x1B, 0x1E, 0x21, 255)
ACTION = (0xF4, 0x60, 0x0C, 255)
ACTION_HI = (0xFF, 0x8A, 0x45, 255)
ACTION_LO = (0xC2, 0x46, 0x05, 255)

ECHELLE = 4


def touche(d, boite, corps, haut, bas, rayon):
    """Un capuchon : arête haute claire, arête basse foncée, comme en CSS."""
    x0, y0, x1, y1 = boite
    e = max(2, (y1 - y0) // 14)          # épaisseur d'arête
    d.rounded_rectangle((x0, y0, x1, y1), rayon, fill=bas)
    d.rounded_rectangle((x0, y0, x1, y1 - e), rayon, fill=corps)
    d.rounded_rectangle((x0, y0, x1, y0 + e), rayon, fill=haut)
    d.rounded_rectangle((x0, y0 + e, x1, y1 - e), 0, fill=corps)


def dessiner(taille, marge_rel, fond_plein):
    """marge_rel : part du côté laissée libre autour du motif.
    fond_plein : True pour l'icône maskable, que le système rogne lui-même."""
    s = taille * ECHELLE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    rayon_fond = 0 if fond_plein else int(s * 0.22)
    d.rounded_rectangle((0, 0, s - 1, s - 1), rayon_fond, fill=CHASSIS)

    # Liseré d'arête du châssis, pour que l'objet ait une épaisseur.
    d.rounded_rectangle((0, 0, s - 1, s - 1), rayon_fond,
                        outline=CHASSIS_DEEP, width=max(2, int(s * 0.015)))

    m = int(s * marge_rel)
    largeur = s - 2 * m
    rayon = max(3, int(s * 0.022))

    # Deux rangées : la première porte la touche orange, la seconde est nue.
    h_rangee = int(largeur * 0.30)
    ecart = int(largeur * 0.10)
    haut1 = (s - (2 * h_rangee + ecart)) // 2
    haut2 = haut1 + h_rangee + ecart

    largeur_action = int(largeur * 0.30)
    joint = max(2, int(s * 0.008))

    # Rangée 1 : entrée + touche qui commet.
    touche(d, (m, haut1, m + largeur - largeur_action - joint, haut1 + h_rangee),
           CAP, CAP_HI, CAP_LO, rayon)
    touche(d, (m + largeur - largeur_action, haut1, m + largeur, haut1 + h_rangee),
           ACTION, ACTION_HI, ACTION_LO, rayon)

    # Rangée 2 : une seconde entrée, pour que ce soit une liste et non un bouton.
    touche(d, (m, haut2, m + largeur, haut2 + h_rangee), CAP, CAP_HI, CAP_LO, rayon)

    # Gravures : deux traits d'encre sur les touches claires, comme un titre et
    # son identifiant. Volontairement illisibles — c'est une texture, pas du texte.
    for haut in (haut1, haut2):
        gx = m + int(largeur * 0.07)
        gy = haut + h_rangee // 2
        ep = max(2, int(h_rangee * 0.13))
        d.rounded_rectangle((gx, gy - ep - ep // 2, gx + int(largeur * 0.34), gy - ep // 2),
                            ep // 2, fill=INK)
        d.rounded_rectangle((gx, gy + ep // 2, gx + int(largeur * 0.22), gy + ep + ep // 2),
                            ep // 2, fill=(0x55, 0x59, 0x5E, 255))

    return img.resize((taille, taille), Image.LANCZOS)


def main():
    DEST.mkdir(exist_ok=True)
    sorties = [
        ("icon-192.png", 192, 0.13, False),
        ("icon-512.png", 512, 0.13, False),
        # Maskable : le système rogne jusqu'à 20 % de chaque bord, le motif doit
        # donc tenir dans la zone sûre centrale et le fond aller au bord.
        ("icon-maskable-512.png", 512, 0.24, True),
    ]
    for nom, taille, marge, plein in sorties:
        chemin = DEST / nom
        dessiner(taille, marge, plein).save(chemin, "PNG", optimize=True)
        print(f"{nom} : {chemin.stat().st_size} octets")


if __name__ == "__main__":
    main()
