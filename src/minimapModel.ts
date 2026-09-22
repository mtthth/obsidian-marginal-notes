// Marginal Notes, par Matthieu Thomas (cidrolin). Licence MIT.

/** Un bloc de la minipage : la partie du texte `[from, to]` qu'il représente, et la tranche de hauteur qu'il y occupe. */
export interface ModelItem {
	from: number;
	to: number;
	top: number;
	height: number;
}

/**
 * Blocs de texte empilés dans l'ordre du document. La minipage s'y repère par des positions dans le
 * texte, jamais par les hauteurs de CM6 : celles-ci ne sont exactes que pour les lignes déjà affichées
 * et se corrigent au fil du défilement, ce qui ferait glisser et se déformer tout ce qu'on dessine.
 * Ici, une même note à la même largeur donne toujours les mêmes hauteurs.
 *
 * Les blocs se suivent par `from` et par `top`, sans se chevaucher. Un intervalle de texte qu'aucun bloc
 * ne couvre (une ligne vide) n'occupe aucune hauteur.
 */
export class StackModel<T extends ModelItem> {
	/** Hauteur de la pile entière. */
	readonly total: number;

	constructor(readonly items: T[]) {
		const last = items[items.length - 1];
		this.total = last ? last.top + last.height : 0;
	}

	/** Indice du dernier bloc dont `key(bloc) <= value`, ou -1. */
	private lastAtOrBefore(value: number, key: (item: T) => number): number {
		let low = 0;
		let high = this.items.length - 1;
		let found = -1;
		while (low <= high) {
			const mid = (low + high) >> 1;
			if (key(this.items[mid]) <= value) {
				found = mid;
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}
		return found;
	}

	/** Indice du bloc qui contient `pos`, ou, dans une ligne vide, de celui qui précède ; 0 avant tout texte. */
	indexAt(pos: number): number {
		return Math.max(0, this.lastAtOrBefore(pos, (item) => item.from));
	}

	/** Indice du bloc qui occupe la hauteur `y`, du premier ou du dernier au-delà des bords. */
	indexAtY(y: number): number {
		return Math.max(0, this.lastAtOrBefore(y, (item) => item.top));
	}

	/** Le bloc qui contient `pos`, ou, dans une ligne vide, celui qui précède ; le premier avant tout texte. */
	itemAt(pos: number): T | undefined {
		return this.items[this.indexAt(pos)];
	}

	/** Le bloc qui occupe la hauteur `y`, le premier ou le dernier au-delà des bords. */
	itemAtY(y: number): T | undefined {
		return this.items[this.indexAtY(y)];
	}

	/** Hauteur de `pos`, proportionnelle à sa place dans le texte de son bloc. */
	y(pos: number): number {
		const item = this.itemAt(pos);
		if (!item || pos < item.from) return 0;
		const span = item.to - item.from;
		const fraction = span > 0 ? Math.min(1, (pos - item.from) / span) : pos > item.to ? 1 : 0;
		return item.top + fraction * item.height;
	}

	/** Haut du bloc qui contient `pos`. */
	top(pos: number): number {
		return this.itemAt(pos)?.top ?? 0;
	}

	/** Bas du bloc qui contient `pos`. */
	bottom(pos: number): number {
		const item = this.itemAt(pos);
		return item ? item.top + item.height : 0;
	}

	/** Position dans le texte à la hauteur `y`, proportionnelle à sa place dans son bloc : réciproque de `y`. */
	posAt(y: number): number {
		const item = this.itemAtY(y);
		if (!item) return 0;
		const fraction = item.height > 0 ? Math.min(1, Math.max(0, (y - item.top) / item.height)) : 0;
		return item.from + Math.round(fraction * (item.to - item.from));
	}
}
