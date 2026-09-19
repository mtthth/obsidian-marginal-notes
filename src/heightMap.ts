/** Tranche de hauteur du document, en pixels de CM6 : `top` est son ordonnée, `height` son épaisseur. */
export interface HeightGap {
	top: number;
	height: number;
}

/**
 * Correspondance entre les hauteurs du document et celles de la minipage, quand celle-ci retire certaines
 * tranches (les lignes vides, qui gardent leur hauteur dans CM6 mais n'ont pas de place dans le dessin).
 * Affine par morceaux : croissante, avec un palier sur chaque tranche retirée.
 */
export class HeightMap {
	/** Ordonnée dans le document où commence chaque tranche retirée, son épaisseur, et le total retiré avant elle. */
	private readonly tops: number[] = [];
	private readonly heights: number[] = [];
	private readonly removedBefore: number[] = [];
	/** Hauteur de la minipage, une fois les tranches retirées. */
	readonly height: number;

	/** `gaps` : dans l'ordre du document, sans chevauchement. */
	constructor(gaps: HeightGap[], docHeight: number) {
		let removed = 0;
		for (const gap of gaps) {
			this.tops.push(gap.top);
			this.heights.push(gap.height);
			this.removedBefore.push(removed);
			removed += gap.height;
		}
		this.height = docHeight - removed;
	}

	/** Correspondance qui ne retire rien. */
	static identity(docHeight: number): HeightMap {
		return new HeightMap([], docHeight);
	}

	/** Indice de la dernière tranche dont `key(i) <= value`, ou -1. `key` doit croître avec l'indice. */
	private lastAtOrBefore(value: number, key: (i: number) => number): number {
		let low = 0;
		let high = this.tops.length - 1;
		let found = -1;
		while (low <= high) {
			const mid = (low + high) >> 1;
			if (key(mid) <= value) {
				found = mid;
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}
		return found;
	}

	/** Hauteur, dans la minipage, du point du document à la hauteur `y` (celui d'une tranche retirée tombe à son bord). */
	compress(y: number): number {
		const i = this.lastAtOrBefore(y, (k) => this.tops[k]);
		if (i < 0) return y;
		return y - this.removedBefore[i] - Math.min(y - this.tops[i], this.heights[i]);
	}

	/**
	 * Réciproque de `compress`. Le bord d'une tranche retirée, où deux hauteurs du document se
	 * confondent, renvoie ce qui la suit : un clic entre deux paragraphes vise le second.
	 */
	expand(mapY: number): number {
		const i = this.lastAtOrBefore(mapY, (k) => this.tops[k] - this.removedBefore[k]);
		if (i < 0) return mapY;
		return mapY + this.removedBefore[i] + this.heights[i];
	}
}
