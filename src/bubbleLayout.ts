// Marginal Notes, par Matthieu Thomas (cidrolin). Licence MIT.

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

/** Nombre de bulles de cette hauteur, séparées de `gap`, qui tiennent l'une sous l'autre dans `maxHeight`. */
function columnCapacity(height: number, maxHeight: number, gap: number): number {
	return height > maxHeight ? 0 : Math.floor((maxHeight - height) / (height + gap)) + 1;
}

/** Les indices de `count` éléments parmi `total`, régulièrement répartis, du premier au dernier. */
function evenlyPicked(total: number, count: number): number[] {
	return Array.from({ length: count }, (_, j) => (count > 1 ? Math.round((j * (total - 1)) / (count - 1)) : 0));
}

/**
 * Place les bulles (triées par `center` croissant) en colonne : toutes contre la minipage, sur une même
 * verticale, à intervalles réguliers. Elles gardent leur ordre dans le texte, si bien que les pointes qui
 * les relient à leurs zones, inclinées, ne se croisent pas. L'intervalle étale la colonne sur l'étendue
 * des zones étiquetées, sans descendre sous la hauteur d'une bulle plus l'écart voulu ; la colonne est
 * centrée sur cette étendue autant que la hauteur disponible le permet. S'il n'y a pas la place de toutes
 * les montrer, celles qui restent sont réparties dans la liste, et les autres ne sont pas placées.
 * Voir `placeColumns` pour ce qui se passe quand une colonne ne suffit pas.
 */
function placeColumn(sizes: BubbleSize[], bounds: Pick<BubbleBounds, "maxHeight" | "gap">): (BubblePlacement | null)[] {
	const { maxHeight, gap } = bounds;
	const height = Math.max(0, ...sizes.map((size) => size.height));
	const count = Math.min(sizes.length, columnCapacity(height, maxHeight, gap));
	const placements: (BubblePlacement | null)[] = sizes.map(() => null);
	if (count === 0) return placements;

	const shown = evenlyPicked(sizes.length, count);
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

/** Nombre d'allers-retours qui ramènent les bulles vers des intervalles réguliers, dans les limites de leurs voisines. */
const RELAXATION_SWEEPS = 30;

export interface ColumnBounds extends Pick<BubbleBounds, "maxHeight" | "gap" | "maxSpread"> {
	/** Distance entre le bord droit d'une bulle contre la minipage et la bande que sa pointe vise. */
	reach: number;
	/** Écart minimal, à la hauteur de la colonne proche, entre une pointe venue de la colonne éloignée et le pied d'une autre. */
	clearance: number;
}

/**
 * Place les bulles en colonne (vue 2). Tant qu'une colonne suffit, c'est `placeColumn`. Au-delà, une
 * deuxième colonne, plus à gauche, prend une bulle sur deux : elles s'entrelacent, dans l'ordre du texte,
 * la colonne proche portant la première, la troisième… Si même deux colonnes ne suffisent pas, ou ne
 * tiennent pas en largeur, on garde les bulles qui peuvent l'être, réparties dans la liste.
 */
export function placeColumns(sizes: BubbleSize[], bounds: ColumnBounds): (BubblePlacement | null)[] {
	const { maxHeight, gap } = bounds;
	const height = Math.max(0, ...sizes.map((size) => size.height));
	if (sizes.length <= columnCapacity(height, maxHeight, gap)) return placeColumn(sizes, bounds);

	// Deux colonnes entrelacées portent deux bulles par intervalle : le plus possible d'abord, puis moins
	// tant que les contraintes de `interleave` ne peuvent pas être satisfaites.
	const most = 2 * Math.floor((maxHeight - height) / (height + gap)) + 1;
	for (let count = Math.min(sizes.length, most); count >= 2; count--) {
		const placements = interleave(sizes, evenlyPicked(sizes.length, count), bounds, height);
		if (placements) return placements;
	}
	return placeColumn(sizes, bounds);
}

/**
 * Deux colonnes, la proche contre la minipage et la lointaine à sa gauche, pour les bulles `shown` (des
 * indices de `sizes`, dans l'ordre du texte), alternées : celles de rang pair dans la proche. Renvoie null
 * si les contraintes ne peuvent être satisfaites.
 *
 * Les pointes sont des segments droits de la bulle à sa bande, dont le bout est à la même distance
 * `reach` de la colonne proche pour toutes. Deux pointes ne se croisent que si leur ordre s'inverse
 * entre leurs deux extrémités. Dans la même colonne, il suffit que les bulles suivent l'ordre du texte.
 * Entre les colonnes, une pointe lointaine (de la hauteur `y` à `t` sur la distance `offset + reach`)
 * passe, à l'aplomb de la colonne proche, à la hauteur `q = y + s (t - y)`, `s = offset / (offset + reach)` :
 * il suffit que ces hauteurs, et celles des bulles proches, suivent l'ordre du texte. C'est ce qu'on
 * impose, avec l'écart minimal `clearance`, en même temps que l'intervalle entre deux bulles d'une même
 * colonne. Ce sont des contraintes de différence entre les `q` ; leur plus petite solution (une passe vers
 * l'avant) dit si elles sont satisfiables, la plus grande (une passe vers l'arrière) ce qu'on peut se
 * permettre. On vise ensuite des bulles à intervalles réguliers, ramenées dans ces limites.
 */
function interleave(
	sizes: BubbleSize[],
	shown: number[],
	bounds: ColumnBounds,
	height: number
): (BubblePlacement | null)[] | null {
	const { maxHeight, gap, maxSpread, reach, clearance } = bounds;
	const count = shown.length;
	const isFar = (j: number) => j % 2 === 1;
	const nearWidth = Math.max(...shown.filter((_, j) => !isFar(j)).map((index) => sizes[index].width));
	const farWidth = Math.max(...shown.filter((_, j) => isFar(j)).map((index) => sizes[index].width));
	// La colonne lointaine commence au-delà de la plus large des bulles proches : à leur hauteur, elles ne se recouvrent pas.
	const offset = nearWidth + gap;
	if (offset + farWidth > maxSpread) return null;

	const s = offset / (offset + reach);
	const half = height / 2;
	const pitch = height + gap;
	const t = shown.map((index) => sizes[index].center);
	// Bornes de `q`, et écart minimal avec la bulle de la même colonne qui précède (`q[j] - q[j - 2]`).
	const lower = (j: number) => (isFar(j) ? (1 - s) * half + s * t[j] : half);
	const upper = (j: number) => (isFar(j) ? (1 - s) * (maxHeight - half) + s * t[j] : maxHeight - half);
	const spacing = (j: number) => (isFar(j) ? (1 - s) * pitch + s * (t[j] - t[j - 2]) : pitch);

	const floors: number[] = [];
	for (let j = 0; j < count; j++) {
		floors[j] = Math.max(lower(j), j > 0 ? floors[j - 1] + clearance : -Infinity, j > 1 ? floors[j - 2] + spacing(j) : -Infinity);
		if (floors[j] > upper(j)) return null;
	}
	const ceilings: number[] = [];
	for (let j = count - 1; j >= 0; j--) {
		ceilings[j] = Math.min(
			upper(j),
			j < count - 1 ? ceilings[j + 1] - clearance : Infinity,
			j < count - 2 ? ceilings[j + 2] - spacing(j + 2) : Infinity
		);
	}

	// Les milieux voulus : à intervalles égaux dans l'ordre du texte (donc deux fois plus espacés dans
	// chaque colonne), sur l'étendue des zones étiquetées, comme pour une seule colonne.
	const first = t[0];
	const last = t[count - 1];
	const listStep = Math.min((maxHeight - height) / (count - 1), Math.max(pitch / 2, (last - first) / (count - 1)));
	const listHeight = (count - 1) * listStep + height;
	const top = Math.min(maxHeight - listHeight, Math.max(0, (first + last) / 2 - listHeight / 2));

	const wanted = shown.map((_, j) => {
		const middle = top + half + j * listStep;
		return isFar(j) ? (1 - s) * middle + s * t[j] : middle;
	});
	// D'abord de proche en proche, chaque `q` au plus près de ce qu'on veut dans les limites que les
	// précédents lui laissent ; puis, par quelques allers-retours, les uns et les autres retouchés dans les
	// limites que leurs deux voisins leur laissent, pour que le choix d'un `q` ne fausse pas tous les suivants.
	const q: number[] = [];
	const lowest = (j: number) =>
		Math.max(lower(j), j > 0 ? q[j - 1] + clearance : -Infinity, j > 1 ? q[j - 2] + spacing(j) : -Infinity);
	for (let j = 0; j < count; j++) q[j] = Math.min(ceilings[j], Math.max(lowest(j), wanted[j]));
	const highest = (j: number) =>
		Math.min(
			upper(j),
			j < count - 1 ? q[j + 1] - clearance : Infinity,
			j < count - 2 ? q[j + 2] - spacing(j + 2) : Infinity
		);
	for (let sweep = 0; sweep < RELAXATION_SWEEPS; sweep++) {
		for (let j = 0; j < count; j++) q[j] = Math.min(highest(j), Math.max(lowest(j), wanted[j]));
		for (let j = count - 1; j >= 0; j--) q[j] = Math.min(highest(j), Math.max(lowest(j), wanted[j]));
	}

	const placements: (BubblePlacement | null)[] = sizes.map(() => null);
	shown.forEach((index, j) => {
		const middle = isFar(j) ? (q[j] - s * t[j]) / (1 - s) : q[j];
		placements[index] = { top: middle - sizes[index].height / 2, offset: isFar(j) ? offset : 0 };
	});
	return placements;
}
