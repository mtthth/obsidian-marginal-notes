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
