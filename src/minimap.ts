import { Platform } from "obsidian";
import { StateField } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { refreshMarkersEffect } from "./model";
import { allParagraphs, frontmatterLastLine, paragraphAt, textStart, type ParagraphBlock } from "./paragraphs";
import { FLASH_DURATION_MS, flashParagraph } from "./flash";
import { rememberCentred } from "./navigation";
import { placeBubbles } from "./bubbleLayout";
import type { TagDecorations } from "./gutter";
import type MarginalNotesPlugin from "./main";

/** Largeur de la minipage : deux fois moindre sur mobile, où l'écran est trop étroit pour elle. */
const WIDTH = Platform.isMobile ? 40 : 80;
/** Marge latérale du dessin, à l'échelle de la largeur pour garder les mêmes proportions. */
const PADDING_X = Platform.isMobile ? 4 : 8;
/** Hauteur maximale d'une ligne affichée, en pixels : une note courte n'est pas agrandie au-delà. */
const MAX_ROW_HEIGHT = 3;
/** En dessous de cette hauteur de ligne, un bloc est dessiné d'un seul aplat plutôt que ligne par ligne. */
const MIN_ROW_HEIGHT = 2;
/** Opacité des lignes de texte ordinaires, et de celles du frontmatter YAML, dessinées plus claires. */
const TEXT_ALPHA = 0.45;
const FRONTMATTER_ALPHA = 0.25;
/** Bulles d'étiquettes, affichées à gauche de la minipage quand on la survole. */
const BUBBLE_GAP = 3;
/** Place laissée à droite des bulles pour leur pointe. */
const BUBBLE_TAIL_SPACE = 6;
/** Hauteur approximative d'une bulle, pour aligner son haut sur celui d'une zone assez haute. */
const BUBBLE_HEIGHT_ESTIMATE = 18;
/** Hauteur minimale du flash dans la minipage : un paragraphe court y fait à peine un pixel. */
const MIN_FLASH_HEIGHT = 4;

/** Bloc de texte à dessiner, en coordonnées de la minipage. */
interface Band {
	top: number;
	height: number;
	rows: number;
	/** Part de la largeur occupée par la dernière ligne à l'écran du bloc. */
	lastRowFill: number;
	color: string | undefined;
	alpha: number;
}

interface Label {
	/** Hauteur, dans la minipage, que la bulle doit viser. */
	center: number;
	text: string;
	color: string | undefined;
	/** Position où placer le curseur quand on clique sur la bulle : début du texte du paragraphe. */
	pos: number;
}

/** Noir ou blanc, selon ce qui se lit le mieux sur `color` ("#rrggbb", "#rgb" ou "rgb(…)"). */
function contrastingTextColor(color: string): string {
	let rgb: number[] | null = null;
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
	if (hex) {
		const digits = hex[1].length === 3 ? hex[1].replace(/./g, "$&$&") : hex[1];
		rgb = [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16));
	} else {
		const channels = color.match(/[\d.]+/g);
		if (channels && channels.length >= 3) rgb = channels.slice(0, 3).map(Number);
	}
	if (!rgb) return "#000000";
	const brightness = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
	return brightness > 0.55 ? "#000000" : "#ffffff";
}

/**
 * Marges haute et basse de la poignée de l'ascenseur d'Obsidian (une bordure transparente), pour
 * que la minipage commence et finisse en face de sa course plutôt qu'au bord de l'éditeur.
 */
function scrollbarInsets(el: HTMLElement): { top: number; bottom: number } {
	const widths = getComputedStyle(el).getPropertyValue("--scrollbar-border-width").trim().split(/\s+/).map(parseFloat);
	return { top: widths[0] || 0, bottom: (widths.length >= 3 ? widths[2] : widths[0]) || 0 };
}

// La minipage représente la note entière « dézoomée » à droite de l'éditeur, comprimée pour ne
// jamais dépasser la hauteur visible. Elle travaille dans l'espace des hauteurs de CM6
// (lineBlockAt) plutôt que ligne source par ligne source : un paragraphe long, qui occupe
// plusieurs lignes à l'écran, y reste proportionnellement haut. Ces hauteurs sont estimées pour
// les lignes jamais affichées et se corrigent au fil du défilement, d'où les redessins sur
// changement de géométrie.
class MinimapView {
	private dom: HTMLElement;
	private canvas: HTMLCanvasElement;
	private viewportEl: HTMLElement;
	private frame = 0;
	/** Pixels de minipage par pixel de document, recalculé à chaque dessin (0 si masquée). */
	private scale = 0;
	private contentHeight = 0;
	private bubbleLayer: HTMLElement;
	private bubbleEls: HTMLElement[] = [];
	/** Bande jaune du paragraphe qui clignote, et ce paragraphe tant que dure son animation. */
	private flashEl: HTMLElement;
	private flashed: { from: number; to: number } | null = null;
	private flashTimer = 0;
	private dragging = false;
	/** Molette : reliquat pas encore converti en cran, taille mesurée d'un cran, paragraphe atteint. */
	private wheelDelta = 0;
	private wheelNotch = 0;
	private stepIndex: number | null = null;

	constructor(
		private view: EditorView,
		private plugin: MarginalNotesPlugin,
		private tagField: StateField<TagDecorations>
	) {
		this.dom = document.createElement("div");
		this.dom.className = "mn-minimap";
		this.dom.style.width = `${WIDTH}px`;
		this.canvas = this.dom.appendChild(document.createElement("canvas"));
		// Avant le cadre de la zone visible, pour que sa bordure reste lisible par-dessus le flash.
		this.flashEl = this.dom.createDiv({ cls: "mn-minimap-flash" });
		this.viewportEl = this.dom.appendChild(document.createElement("div"));
		this.viewportEl.className = "mn-minimap-viewport";
		// Dans la minipage (et non à côté) pour que survoler une bulle compte comme survoler la minipage.
		this.bubbleLayer = this.dom.createDiv({ cls: "mn-minimap-bubbles" });
		view.dom.appendChild(this.dom);

		this.dom.addEventListener("pointerdown", this.onPointerDown);
		this.dom.addEventListener("pointermove", this.onPointerMove);
		this.dom.addEventListener("pointerup", this.onPointerUp);
		this.dom.addEventListener("pointercancel", this.onPointerUp);
		this.dom.addEventListener("wheel", this.onWheel, { passive: false });
		this.dom.addEventListener("pointerleave", this.resetStepping);
		view.scrollDOM.addEventListener("scroll", this.onScroll);
		this.schedule();
	}

	update(update: ViewUpdate) {
		if (
			update.docChanged ||
			update.geometryChanged ||
			update.heightChanged ||
			update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshMarkersEffect)))
		) {
			if (update.docChanged) {
				this.resetStepping();
				// Les positions retenues ne désignent plus le même texte.
				this.flashed = null;
			}
			this.schedule();
		}
	}

	destroy() {
		cancelAnimationFrame(this.frame);
		window.clearTimeout(this.flashTimer);
		this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
		this.reserveSpace(false);
		this.dom.remove();
	}

	/** Réserve la largeur de la minipage à droite de la zone de défilement, pour ne pas recouvrir le texte. */
	private reserveSpace(reserve: boolean) {
		// En style en ligne sur scrollDOM : CM6 réécrit l'attribut class de view.dom à chaque mise à jour.
		const margin = reserve ? `${WIDTH}px` : "";
		if (this.view.scrollDOM.style.marginInlineEnd !== margin) this.view.scrollDOM.style.marginInlineEnd = margin;
	}

	private schedule() {
		if (this.frame) return;
		this.frame = requestAnimationFrame(() => {
			this.frame = 0;
			this.draw();
		});
	}

	private draw() {
		const { view } = this;
		const doc = view.state.doc;
		const docHeight = view.lineBlockAt(doc.length).bottom;
		const editorHeight = view.dom.clientHeight;
		// Seulement dans l'éditeur principal d'une note (pas dans les éditeurs intégrés au canevas,
		// aux fenêtres de survol…) ; l'éditeur est aussi présent mais masqué en mode lecture.
		const inNote = view.dom.closest('.workspace-leaf-content[data-type="markdown"]') !== null;
		if (!this.plugin.settings.showMinimap || !inNote || editorHeight === 0 || docHeight === 0) {
			this.scale = 0;
			this.reserveSpace(false);
			this.dom.hide();
			return;
		}
		this.reserveSpace(true);
		this.dom.show();

		const lineHeight = view.defaultLineHeight;
		const insets = scrollbarInsets(view.dom);
		const available = Math.max(1, editorHeight - insets.top - insets.bottom);
		this.scale = Math.min(available / docHeight, MAX_ROW_HEIGHT / lineHeight);
		this.contentHeight = Math.floor(docHeight * this.scale);

		const { bands, labels } = this.layout(lineHeight);

		const height = this.contentHeight;
		const ratio = window.devicePixelRatio || 1;
		this.dom.style.top = `${insets.top}px`;
		this.dom.style.height = `${height}px`;
		this.canvas.width = Math.round(WIDTH * ratio);
		this.canvas.height = Math.round(height * ratio);
		this.canvas.style.width = `${WIDTH}px`;
		this.canvas.style.height = `${height}px`;
		this.renderBubbles(labels, available);

		const ctx = this.canvas.getContext("2d");
		if (!ctx) return;
		ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		const textColor = getComputedStyle(view.contentDOM).color;
		this.paintBands(ctx, bands, textColor);
		this.updateViewport();
		this.placeFlash();
	}

	/** Bandes de texte et étiquettes de la note, positionnées à l'échelle courante. */
	private layout(lineHeight: number): { bands: Band[]; labels: Label[] } {
		const { view } = this;
		const doc = view.state.doc;
		const charsPerRow = Math.max(1, view.contentDOM.clientWidth / view.defaultCharacterWidth);
		const tagged = view.state.field(this.tagField).tagged;
		const frontmatterEnd = frontmatterLastLine(doc);
		const bands: Band[] = [];
		const labels: Label[] = [];
		let t = 0;

		for (let n = 1; n <= doc.lines; n++) {
			const line = doc.line(n);
			if (line.text.trim() === "") continue;
			const block = view.lineBlockAt(line.from);
			// Une ligne repliée ou remplacée par un widget partage le bloc d'une ligne précédente.
			if (block.from !== line.from) continue;

			while (t < tagged.length && tagged[t].block.to < line.from) t++;
			const zone = t < tagged.length && tagged[t].block.from <= line.from ? tagged[t] : undefined;
			const color = this.plugin.paletteColor(zone?.tag.color);
			const top = block.top * this.scale;
			const length = block.to - block.from;
			// Nombre de lignes à l'écran : d'après la hauteur du bloc, sans dépasser ce que la
			// longueur du texte justifie (un titre est plus haut sans être plus long).
			const rows = Math.max(1, Math.min(Math.round(block.height / lineHeight), Math.ceil(length / charsPerRow)));
			bands.push({
				top,
				height: block.height * this.scale,
				rows,
				lastRowFill: Math.min(1, Math.max(0.15, (length - (rows - 1) * charsPerRow) / charsPerRow)),
				color,
				alpha: color ? 1 : n <= frontmatterEnd ? FRONTMATTER_ALPHA : TEXT_ALPHA,
			});

			if (zone?.tag.text && zone.block.from === line.from) {
				// Bulle centrée sur une zone fine, alignée sur le haut d'une zone plus haute qu'elle.
				const zoneHeight = (view.lineBlockAt(zone.block.to).bottom - block.top) * this.scale;
				labels.push({
					center: top + Math.min(zoneHeight, BUBBLE_HEIGHT_ESTIMATE) / 2,
					text: zone.tag.text,
					color,
					pos: zone.block.markerFrom + zone.matchLength,
				});
			}
		}
		return { bands, labels };
	}

	private paintBands(ctx: CanvasRenderingContext2D, bands: Band[], textColor: string) {
		const barWidth = WIDTH - 2 * PADDING_X;
		for (const band of bands) {
			ctx.fillStyle = band.color ?? textColor;
			ctx.globalAlpha = band.alpha;
			const rowHeight = band.height / band.rows;
			if (rowHeight < MIN_ROW_HEIGHT) {
				// Trop comprimé pour distinguer les lignes : un aplat, avec une hauteur plancher pour
				// qu'un court paragraphe étiqueté reste visible même dans une longue note.
				const minHeight = band.color ? MIN_ROW_HEIGHT : 1;
				ctx.fillRect(PADDING_X, band.top, barWidth, Math.max(band.height, minHeight));
				continue;
			}
			const barHeight = rowHeight * 0.6;
			for (let r = 0; r < band.rows; r++) {
				const fill = r < band.rows - 1 ? 1 : band.lastRowFill;
				ctx.fillRect(PADDING_X, band.top + r * rowHeight + (rowHeight - barHeight) / 2, barWidth * fill, barHeight);
			}
		}
	}

	/**
	 * Bulles des étiquettes, à gauche de la minipage et par-dessus le texte. Masquées en CSS tant que
	 * la minipage n'est pas survolée, mais toujours mises en page pour pouvoir être mesurées.
	 */
	private renderBubbles(labels: Label[], maxHeight: number) {
		while (this.bubbleEls.length < labels.length) {
			const el = this.bubbleLayer.createDiv({ cls: "mn-bubble" });
			el.createSpan({ cls: "mn-bubble-text" });
			this.bubbleEls.push(el);
		}
		while (this.bubbleEls.length > labels.length) this.bubbleEls.pop()?.remove();

		labels.forEach((label, i) => {
			const el = this.bubbleEls[i];
			el.show();
			// Même position pour toutes avant la mesure, quelle que soit la place du dessin précédent.
			el.style.top = "0px";
			el.style.right = "0px";
			(el.firstElementChild as HTMLElement).textContent = label.text;
			el.title = label.text;
			el.dataset.pos = String(label.pos);
			el.toggleClass("mn-colorless", !label.color);
			if (label.color) {
				el.style.setProperty("--mn-bubble-bg", label.color);
				el.style.color = contrastingTextColor(label.color);
			} else {
				el.style.removeProperty("--mn-bubble-bg");
				el.style.color = "";
			}
		});

		const sizes = labels.map((label, i) => ({
			center: label.center,
			width: this.bubbleEls[i].offsetWidth,
			height: this.bubbleEls[i].offsetHeight,
		}));
		const placements = placeBubbles(sizes, {
			maxHeight,
			// Jusqu'au bord gauche de la colonne de texte, pas au-delà dans la marge.
			maxSpread: Math.max(
				0,
				this.dom.getBoundingClientRect().left - this.view.contentDOM.getBoundingClientRect().left - BUBBLE_TAIL_SPACE
			),
			gap: BUBBLE_GAP,
			maxNudge: BUBBLE_HEIGHT_ESTIMATE * 0.75,
		});

		placements.forEach((placement, i) => {
			const el = this.bubbleEls[i];
			if (!placement) {
				el.hide();
				return;
			}
			el.style.top = `${placement.top}px`;
			el.style.right = `${placement.offset + BUBBLE_TAIL_SPACE}px`;
			// La pointe vers la zone n'a de sens que pour une bulle collée à la minipage.
			el.toggleClass("mn-has-tail", placement.offset === 0);
			const tailY = Math.min(sizes[i].height - 6, Math.max(6, sizes[i].center - placement.top));
			el.style.setProperty("--mn-tail-y", `${tailY}px`);
		});
	}

	/** Cadre indiquant la portion de la note actuellement visible dans l'éditeur. */
	private updateViewport() {
		if (!this.scale) return;
		const { view } = this;
		const mapHeight = this.contentHeight;
		const scrolled = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
		const top = Math.min(mapHeight, Math.max(0, scrolled * this.scale));
		const bottom = Math.min(mapHeight, Math.max(0, (scrolled + view.scrollDOM.clientHeight) * this.scale));
		this.viewportEl.style.top = `${top}px`;
		this.viewportEl.style.height = `${bottom - top}px`;
	}

	private onScroll = () => this.updateViewport();

	private onPointerDown = (event: PointerEvent) => {
		if (event.button !== 0 || !this.scale) return;
		event.preventDefault();
		event.stopPropagation();
		// Le prochain cran de molette repartira d'ici, et non du paragraphe atteint avant le clic.
		this.resetStepping();

		// Un clic sur une bulle mène au début de son paragraphe, même si elle a été décalée.
		const bubble = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(".mn-bubble") : null;
		if (bubble) {
			const pos = Number(bubble.dataset.pos);
			this.scrollToPos(pos, true);
			this.flashAt(pos);
			return;
		}

		this.dom.setPointerCapture(event.pointerId);
		this.dragging = true;
		this.jumpTo(event.clientY, true);
	};

	private onPointerMove = (event: PointerEvent) => {
		if (this.dragging) this.jumpTo(event.clientY, false);
	};

	private onPointerUp = () => {
		this.dragging = false;
	};

	// La minipage est hors de la zone de défilement de l'éditeur : la molette n'y agit pas d'elle-même.
	// On la relaie en pas de lecture : un cran amène le paragraphe suivant au centre et le fait
	// clignoter. La taille d'un cran vient du système et ne se déduit pas de la police : on la mesure
	// sur le plus grand delta reçu. Une souris donne alors exactement un paragraphe par cran ; la
	// rafale de petits deltas d'un pavé tactile s'accumule jusqu'à un pas, proportionnel à la distance.
	private onWheel = (event: WheelEvent) => {
		if (event.ctrlKey || !this.scale || event.deltaY === 0) return;
		event.preventDefault();
		const { view } = this;
		const unit =
			event.deltaMode === WheelEvent.DOM_DELTA_LINE
				? view.defaultLineHeight
				: event.deltaMode === WheelEvent.DOM_DELTA_PAGE
				? view.scrollDOM.clientHeight
				: 1;
		const delta = event.deltaY * unit;
		// Un changement de sens repart de zéro, pour qu'un reliquat ne déclenche pas un cran à contretemps.
		if (Math.sign(delta) !== Math.sign(this.wheelDelta)) this.wheelDelta = 0;
		this.wheelDelta += delta;
		this.wheelNotch = Math.max(this.wheelNotch, Math.abs(delta), view.defaultLineHeight);
		const steps = Math.trunc(this.wheelDelta / this.wheelNotch);
		if (!steps) return;
		this.wheelDelta -= steps * this.wheelNotch;
		this.stepParagraphs(steps);
	};

	/** Oublie où l'on en était : le prochain cran de molette repartira de ce qui est à l'écran. */
	private resetStepping = () => {
		this.stepIndex = null;
		this.wheelDelta = 0;
		this.wheelNotch = 0;
	};

	/** Avance de `steps` paragraphes (négatif : recule), depuis le dernier cran ou depuis le milieu de l'écran. */
	private stepParagraphs(steps: number) {
		const { view } = this;
		const blocks = allParagraphs(view.state);
		if (blocks.length === 0) return;
		const current = this.stepIndex ?? this.centerIndex(blocks);
		const index = Math.min(blocks.length - 1, Math.max(0, current + steps));
		// Rien à faire si le bord du document a ramené le pas sur place, ou à contresens du cran
		// (molette vers le haut alors qu'on est déjà avant le premier paragraphe, dans le frontmatter).
		if (Math.sign(index - current) !== Math.sign(steps)) return;
		this.stepIndex = index;
		const block = blocks[index];
		this.scrollToPos(block.from, false);
		this.flash(block);
	}

	/**
	 * Fait clignoter un paragraphe des deux côtés — sa bande dans la minipage, son texte dans l'éditeur
	 * — et le retient comme paragraphe centré : tous ceux qui appellent cette méthode viennent d'y mener
	 * la vue, et un clic dedans n'aura donc pas à l'y ramener.
	 */
	private flash(block: ParagraphBlock) {
		rememberCentred(this.view, block.from);
		this.flashed = { from: block.from, to: block.to };
		window.clearTimeout(this.flashTimer);
		this.flashTimer = window.setTimeout(() => (this.flashed = null), FLASH_DURATION_MS);
		this.placeFlash();
		// Rejoue l'animation même si la précédente court encore : retirer la classe, forcer le
		// recalcul du style, la remettre.
		this.flashEl.removeClass("mn-flash");
		void this.flashEl.offsetWidth;
		this.flashEl.addClass("mn-flash");
		flashParagraph(this.view, block.from, block.to);
	}

	/** Idem à partir d'une position quelconque : le paragraphe qui la contient, s'il y en a un. */
	private flashAt(pos: number) {
		const block = paragraphAt(this.view.state, pos);
		if (block) this.flash(block);
	}

	/** (Re)place la bande du flash : l'échelle de la minipage change au fil du défilement. */
	private placeFlash() {
		const flashed = this.flashed;
		if (!flashed || !this.scale) return;
		const { view } = this;
		const top = view.lineBlockAt(flashed.from).top * this.scale;
		const bottom = view.lineBlockAt(flashed.to).bottom * this.scale;
		this.flashEl.style.top = `${top}px`;
		this.flashEl.style.height = `${Math.max(bottom - top, MIN_FLASH_HEIGHT)}px`;
	}

	/**
	 * Indice du paragraphe au milieu de la zone visible, point de départ d'une série de crans.
	 * Vaut -1 avant le premier paragraphe (frontmatter), pour qu'un cran vers le bas y mène.
	 */
	private centerIndex(blocks: ParagraphBlock[]): number {
		const { view } = this;
		const scrolled = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
		const pos = view.lineBlockAtHeight(scrolled + view.scrollDOM.clientHeight / 2).from;
		let index = -1;
		while (index + 1 < blocks.length && blocks[index + 1].from <= pos) index++;
		return index;
	}

	/**
	 * Centre l'éditeur sur l'endroit de la note correspondant à `clientY`. Au clic (et non pendant un
	 * glissement, qui clignoterait à chaque mouvement), y place aussi le curseur et fait clignoter l'arrivée.
	 */
	private jumpTo(clientY: number, click: boolean) {
		const { view } = this;
		const docHeight = view.lineBlockAt(view.state.doc.length).bottom;
		const y = (clientY - this.canvas.getBoundingClientRect().top) / this.scale;
		const height = Math.min(docHeight, Math.max(0, y));
		const block = view.lineBlockAtHeight(height);
		// Pendant un glissement, vise la position proportionnelle dans le bloc plutôt que son début :
		// le texte défile alors continûment sous le pointeur.
		const fraction = block.height > 0 ? Math.min(1, Math.max(0, (height - block.top) / block.height)) : 0;
		const pos = block.from + Math.round(fraction * (block.to - block.from));
		if (!click) {
			this.scrollToPos(pos, false);
			return;
		}
		// Au clic, on centre le paragraphe visé — celui-là même qui clignote — et non le point exact.
		const paragraph = paragraphAt(view.state, pos);
		this.scrollToPos(paragraph ? textStart(paragraph) : pos, true);
		if (paragraph) this.flash(paragraph);
	}

	private scrollToPos(pos: number, moveCursor: boolean) {
		const { view } = this;
		// Sur mobile, la minipage ne sert qu'à naviguer : rendre le focus à l'éditeur y ferait
		// surgir le clavier, et une sélection en attente le ferait surgir au prochain focus.
		const focusEditor = moveCursor && !Platform.isMobile;
		view.dispatch({
			selection: focusEditor ? { anchor: pos } : undefined,
			effects: EditorView.scrollIntoView(pos, { y: "center" }),
		});
		if (focusEditor) view.focus();
	}
}

export function createMinimap(plugin: MarginalNotesPlugin, tagField: StateField<TagDecorations>) {
	return ViewPlugin.define((view) => new MinimapView(view, plugin, tagField));
}
