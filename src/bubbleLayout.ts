export interface BubbleSize {
	/** Hauteur visée pour le centre de la bulle (celle de la zone étiquetée dans la minipage). */
	center: number;
	width: number;
	height: number;
}

export interface BubblePlacement {
	top: number;
	/** Distance entre le bord droit de la bulle et le bord gauche de la minipage. */
	offset: number;
}

export interface BubbleBounds {
	/** Hauteur disponible : aucune bulle ne descend plus bas. */
	maxHeight: number;
	/** Largeur disponible à gauche de la minipage : aucune bulle ne va plus loin. */
	maxSpread: number;
	gap: number;
	/** Décalage vertical maximal toléré avant de préférer un décalage vers la gauche. */
	maxNudge: number;
}

interface Rect {
	top: number;
	bottom: number;
	offset: number;
	end: number;
}

/**
 * Place les bulles (triées par `center` croissant) sans chevauchement, dans cet ordre de préférence :
 * à leur hauteur contre la minipage ; un peu plus bas ; décalées vers la gauche au-delà des bulles
 * qui les gênent ; en dernier recours plus bas contre la minipage. Renvoie null pour une bulle qui
 * ne tient nulle part.
 */
export function placeBubbles(sizes: BubbleSize[], bounds: BubbleBounds): (BubblePlacement | null)[] {
	const { maxHeight, maxSpread, gap, maxNudge } = bounds;
	const placed: Rect[] = [];

	const colliders = (top: number, height: number, offset: number, width: number) =>
		placed.filter(
			(p) => top < p.bottom + gap && top + height + gap > p.top && offset < p.end + gap && offset + width + gap > p.offset
		);

	/** Première hauteur libre à partir de `top`, contre la minipage, en descendant sous les bulles gênantes. */
	const freeTopBelow = (top: number, width: number, height: number) => {
		for (let found = colliders(top, height, 0, width); found.length > 0; found = colliders(top, height, 0, width)) {
			top = Math.max(...found.map((p) => p.bottom + gap));
		}
		return top;
	};

	return sizes.map(({ center, width, height }) => {
		const place = (top: number, offset: number): BubblePlacement => {
			placed.push({ top, bottom: top + height, offset, end: offset + width });
			return { top, offset };
		};
		if (height > maxHeight) return null;
		const idealTop = Math.min(maxHeight - height, Math.max(0, center - height / 2));

		const nudgedTop = freeTopBelow(idealTop, width, height);
		if (nudgedTop - idealTop <= maxNudge && nudgedTop + height <= maxHeight) return place(nudgedTop, 0);

		let offset = 0;
		for (let found = colliders(idealTop, height, offset, width); found.length > 0; found = colliders(idealTop, height, offset, width)) {
			offset = Math.max(...found.map((p) => p.end + gap));
		}
		if (offset + width <= maxSpread) return place(idealTop, offset);

		return nudgedTop + height <= maxHeight ? place(nudgedTop, 0) : null;
	});
}

/**
 * Place les bulles (triées par `center` croissant) en colonne : toutes contre la minipage, sur une même
 * verticale, à intervalles réguliers. Elles gardent leur ordre dans le texte, si bien que les pointes qui
 * les relient à leurs zones, inclinées, ne se croisent pas. L'intervalle étale la colonne sur l'étendue
 * des zones étiquetées, sans descendre sous la hauteur d'une bulle plus l'écart voulu ; la colonne est
 * centrée sur cette étendue autant que la hauteur disponible le permet. S'il n'y a pas la place de toutes
 * les montrer, celles qui restent sont réparties dans la liste, et les autres ne sont pas placées.
 */
export function placeColumn(sizes: BubbleSize[], bounds: Pick<BubbleBounds, "maxHeight" | "gap">): (BubblePlacement | null)[] {
	const { maxHeight, gap } = bounds;
	const height = Math.max(0, ...sizes.map((size) => size.height));
	const capacity = height > maxHeight ? 0 : Math.floor((maxHeight - height) / (height + gap)) + 1;
	const count = Math.min(sizes.length, capacity);
	const placements: (BubblePlacement | null)[] = sizes.map(() => null);
	if (count === 0) return placements;

	// Les bulles montrées, réparties dans la liste (toutes, quand il y a la place).
	const shown = Array.from({ length: count }, (_, j) => (count > 1 ? Math.round((j * (sizes.length - 1)) / (count - 1)) : 0));
	const first = sizes[shown[0]].center;
	const last = sizes[shown[count - 1]].center;
	const pitch =
		count > 1 ? Math.min((maxHeight - height) / (count - 1), Math.max(height + gap, (last - first) / (count - 1))) : 0;
	const columnHeight = (count - 1) * pitch + height;
	const top = Math.min(maxHeight - columnHeight, Math.max(0, (first + last) / 2 - columnHeight / 2));

	shown.forEach((index, j) => {
		// Les milieux sont à intervalles égaux, même si les bulles n'ont pas toutes la même hauteur.
		placements[index] = { top: top + j * pitch + (height - sizes[index].height) / 2, offset: 0 };
	});
	return placements;
}
