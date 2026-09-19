# Marginal Notes

Plugin [Obsidian](https://obsidian.md) pour annoter ses textes dans la marge, paragraphe par paragraphe : une **couleur** et un **texte court** par paragraphe, une **minipage** qui montre toute la note d'un coup d'œil, et des **pages cornées** pour marquer les endroits où revenir. Pensé pour le travail d'écriture : savoir ce qui est à retravailler, en cours ou validé sans quitter le texte.

Les annotations sont enregistrées dans la note elle-même, sous la forme d'un commentaire Obsidian (`%%…%%`) : pas de fichier annexe, rien à synchroniser.

## Ce que fait le plugin

### Étiquettes de paragraphe

- **Une couleur** (cinq par défaut : *À retravailler*, *En cours*, *Validé*, *Idée à explorer*, *Recherche*) et/ou **un texte court** par paragraphe.
- La couleur s'affiche dans la gouttière, sous la forme d'un ovale vertical de la hauteur du paragraphe, et en fond discret derrière le texte. Le texte s'affiche dans une bulle de la minipage, et en infobulle sur l'ovale.
- Le mode lecture affiche l'ovale et le fond dans la marge du bloc rendu.
- Pour étiqueter : clic droit dans le paragraphe → **Étiqueter le paragraphe courant**, ou la commande du même nom.

### Minipage

Une vue d'ensemble de la note, à droite de l'éditeur, qui la représente « dézoomée » dans la hauteur visible.

- **Clic** : centre le paragraphe visé, pose le curseur dedans et le fait clignoter. **Glisser** : fait défiler la note. **Molette** : avance ou recule d'un paragraphe par cran.
- Un cadre indique la portion de la note visible dans l'éditeur.
- Les paragraphes étiquetés y apparaissent dans leur couleur. Au survol, leurs **bulles** affichent le texte de l'étiquette, et les **repères de sections** numérotent les titres de niveau 2 et 3 (1, 1.1…) ; un trait de séparation y est marqué d'une étoile. Cliquer sur une bulle ou un repère y mène.
- **Recherche** : quand un mot est tapé dans la barre de recherche d'Obsidian (Ctrl+F), chaque occurrence est encadrée dans le texte et les blocs concernés sont mis en valeur dans la minipage.
- **Clic droit dans la minipage** : corne ou décorne le paragraphe visé, sans s'y rendre.
- Sur mobile, la minipage est deux fois plus étroite et sert seulement à naviguer.

Le **style** de la minipage se règle : *Bloc plein* (un aplat par bloc de texte, séparé du suivant par la ligne vide de la note) ou *Paragraphes* (les lignes vides disparaissent, et chaque paragraphe se reconnaît à sa dernière ligne plus courte et, au choix, à son alinéa).

### Pages cornées

Un paragraphe peut être **corné** : un simple repère pour y revenir, sans couleur ni texte. Il apparaît comme un triangle rouge dans la marge de la minipage. Clic droit dans le texte → **Corner la page** (ou **Retirer la corne**), ou clic droit sur la minipage.

### Navigation

- Commandes **Aller à l'étiquette suivante** / **précédente** : placent le curseur au début du paragraphe étiqueté voisin, c'est-à-dire qui porte une couleur ou un texte. Les pages cornées n'en font pas partie.
- **Centrage au clic** (réglable) : le premier clic dans un paragraphe le centre à l'écran et le fait clignoter ; un second clic dans le même paragraphe se contente de poser le curseur.

## Commandes

| Commande | Effet |
|---|---|
| Étiqueter le paragraphe courant | Ouvre le menu : couleur, texte, suppression |
| Aller à l'étiquette suivante | Curseur au paragraphe étiqueté suivant (couleur ou texte) |
| Aller à l'étiquette précédente | Curseur au paragraphe étiqueté précédent (couleur ou texte) |

Aucun raccourci n'est défini par défaut : à assigner dans *Réglages → Raccourcis clavier*.

## Réglages

*Réglages → Marginal Notes* :

- **Palette de couleurs** : libellé et couleur de chaque entrée, ajout et suppression. Renommer ou recolorer une entrée met à jour tous les paragraphes qui l'utilisent.
- **Transparence du fond** des paragraphes étiquetés (0 % = couleur pleine, 100 % = aucun fond).
- **Centrer le paragraphe au clic**.
- **Afficher la minipage**, son **style** (*Bloc plein* ou *Paragraphes*) et l'**alinéa**.

## Format dans la note

Un paragraphe étiqueté commence par un commentaire Obsidian :

```
%%mn corne c=violet t=à reprendre%% Le texte du paragraphe…
```

- `corne` : page cornée (facultatif) ;
- `c=<clé>` : clé de la couleur dans la palette (facultatif) ;
- `t=<texte>` : texte court, qui ne peut pas contenir de `%` (facultatif).

Au moins l'un des trois est requis. Le commentaire se modifie à la main comme n'importe quel texte, et il reste masqué en mode lecture.

## Ce qu'est un paragraphe

Le plugin découpe la note lui-même, en blocs de lignes non vides séparés par des lignes vides. Un titre forme un bloc à lui seul. Sont ignorés : le frontmatter, les blocs de code, de maths et de commentaires. Les tableaux et les en-têtes de callout ne peuvent pas être étiquetés, car un marqueur en tête casserait leur rendu.

## Installation

Le plugin n'est pas encore publié dans le répertoire des plugins communautaires ni en version packagée. Pour l'installer à la main, à partir des sources :

```bash
git clone https://github.com/mtthth/obsidian-marginal-notes.git
cd obsidian-marginal-notes
npm install
npm run build
```

Copier ensuite `main.js`, `manifest.json` et `styles.css` dans le dossier `.obsidian/plugins/marginal-notes/` du vault, puis activer *Marginal Notes* dans *Réglages → Plugins communautaires*.

Obsidian 1.4.0 ou plus récent.

## Développement

```bash
npm install
npm run dev     # compile en continu vers main.js
npm run build   # vérifie les types, puis compile pour la production
```

Sous Windows, `deploy.ps1` compile et copie le plugin dans un vault :

```powershell
.\deploy.ps1 -VaultPath "C:\chemin\du\vault"
```

Le chemin est mémorisé dans `deploy.local.json` (ignoré par git) : les fois suivantes, `.\deploy.ps1` suffit. Recharger ensuite Obsidian (Ctrl+R).

Le code est dans `src/` :

| Fichier | Rôle |
|---|---|
| `main.ts` | Point d'entrée : extensions de l'éditeur, commandes, menu contextuel |
| `paragraphs.ts` | Découpage de la note en paragraphes, titres et sections |
| `model.ts` | Palette, format et lecture du marqueur `%%mn …%%` |
| `gutter.ts` | Ovales de la gouttière et fond des paragraphes étiquetés |
| `reading.ts` | Affichage des étiquettes en mode lecture |
| `minimap.ts`, `minimapModel.ts`, `bubbleLayout.ts` | Minipage, son modèle de hauteurs et le placement de ses bulles |
| `menu.ts`, `tagEdit.ts`, `textInputModal.ts` | Menu d'étiquetage et édition du marqueur |
| `navigation.ts`, `flash.ts`, `centerFlash.ts` | Centrage au clic, saut d'étiquette en étiquette, clignotement |
| `search.ts` | Occurrences de la recherche Ctrl+F |
| `settings.ts` | Réglages |

### Note sur la minipage

La minipage ne se dessine pas d'après les hauteurs de CodeMirror : celles-ci ne sont exactes que pour les lignes déjà affichées et se corrigent au fil du défilement, ce qui déformait la minipage pendant qu'on y glissait. Elle a son propre modèle, tiré du seul texte : un bloc est aussi haut que sa longueur et la largeur de la colonne le disent. Contrepartie : un titre, une image ou un tableau n'y est pas plus haut qu'une ligne.

## Licence

[MIT](LICENSE) © 2026 Matthieu Thomas
