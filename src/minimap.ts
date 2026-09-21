import { Platform } from "obsidian";
import { StateField, type Text } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { refreshMarkersEffect } from "./model";
import {
	allParagraphs,
	allSections,
	frontmatterLastLine,
	paragraphAt,
	textStart,
	textWithoutMarker,
	type ParagraphBlock,
	type SectionBoundary,
} from "./paragraphs";
import { FLASH_DURATION_MS, flashParagraph } from "./flash";
import { rememberCentred } from "./navigation";
import { placeBubbles, placeColumns } from "./bubbleLayout";
import { StackModel, type ModelItem } from "./minimapModel";
import { problemSpans, problemZonesKey, type ProblemSpan } from "./problemZones";
import { SearchWatcher } from "./search";
import { toggleCorner } from "./tagEdit";
import type { TagDecorations } from "./gutter";
import type MarginalNotesPlugin from "./main";

/** Largeur de la minipage : deux fois moindre sur mobile, où l'écran est trop étroit pour elle. */
const WIDTH = Platform.isMobile ? 40 : 80;
/** Marge latérale du dessin, à l'échelle de la largeur pour garder les mêmes proportions. */
const PADDING_X = Platform.isMobile ? 4 : 8;
/** Hauteur maximale d'une ligne affichée, en pixels : une note courte n'est pas agrandie au-delà. */
const MAX_ROW_HEIGHT = 3;
/**
 * En dessous de cette hauteur de ligne, il n'y a plus de place pour un interligne. « Bloc plein » dessine
 * alors un bloc d'un seul aplat ; « Paragraphes » des rangées pleines qui se touchent, jusqu'à ne plus
 * former qu'un aplat dont on ne voit que le contour. C'est aussi la hauteur plancher d'un court
 * paragraphe étiqueté.
 */
const MIN_ROW_HEIGHT = 2;
/**
 * Style « Paragraphes » : sans ligne vide entre deux paragraphes, c'est leur forme qui les sépare, comme
 * dans un texte imprimé : une dernière rangée qui n'atteint jamais la marge, et, au réglage, une
 * première rangée en retrait (l'alinéa).
 */
const INDENT_X = PADDING_X / 2;
/** Part de la largeur que peut occuper la dernière rangée d'un paragraphe : au-delà, elle ne se verrait plus écourtée. */
const RUN_END_FILL_MAX = 0.85;
/** Opacité des lignes de texte ordinaires, et de celles du frontmatter YAML, dessinées plus claires. */
const TEXT_ALPHA = 0.45;
const FRONTMATTER_ALPHA = 0.25;
/**
 * Paragraphe survolé, dessiné plus soutenu : ses lignes ordinaires gagnent en opacité, et une bande
 * de couleur, déjà opaque, se rapproche de la couleur du texte (plus foncée en thème clair).
 */
const HOVER_ALPHA_BOOST = 0.45;
const HOVER_COLOR_MIX = 0.35;
/**
 * Aperçu du texte du paragraphe survolé : un cadre sur le tiers gauche de l'éditeur, à cette distance de
 * ses bords, et pas plus étroit que ce minimum. Seul le début du texte y est mis : le reste ne se verrait pas.
 */
const PREVIEW_INSET = 12;
const PREVIEW_MIN_WIDTH = 220;
const PREVIEW_MAX_CHARS = 3000;
/** Opacité du fond qui met en valeur les blocs où apparaît le mot cherché (Ctrl+F). */
const SEARCH_ALPHA = 0.9;
/** Bulles d'étiquettes, affichées à gauche de la minipage quand on la survole. */
const BUBBLE_GAP = 3;
/** Place laissée à droite des bulles pour leur pointe, en plus de la colonne des repères de sections. */
const BUBBLE_TAIL_SPACE = 10;
/**
 * Pointe d'une bulle : un biseau de cette hauteur contre la bulle, effilé jusqu'à cette hauteur contre la
 * bande du paragraphe ; sa naissance est cachée de tant de pixels sous la bulle ; il n'y en a pas si la
 * bulle est plus oblique que ce décalage vertical.
 */
const TAIL_BASE = 12;
const TAIL_TIP = 2;
const TAIL_JOIN = 10;
const TAIL_MAX_SLANT = 30;
const SVG_NS = "http://www.w3.org/2000/svg";
/** Hauteur approximative d'une bulle, pour borner le décalage vertical qu'on tolère avant de la pousser vers la gauche. */
const BUBBLE_HEIGHT_ESTIMATE = 18;
/** Hauteur minimale du flash dans la minipage : un paragraphe court y fait à peine un pixel. */
const MIN_FLASH_HEIGHT = 4;
/** Repère d'un trait de séparation, qui n'a pas de numéro. */
const RULE_BADGE = "★";
/** Écart vertical entre deux repères de sections que l'échelle de la minipage a rapprochés. */
const SECTION_GAP = 2;
/** Écart horizontal entre la colonne des repères de sections et les bulles d'étiquettes. */
const SECTION_BUBBLE_GAP = 4;
/** Côté du triangle d'une page cornée : toute la marge de la minipage, à droite du texte. */
const CORNER_SIZE = Platform.isMobile ? 4 : 8;
/** Couleur de repli par défaut, si le thème ne définit pas --mn-corner-color (voir styles.css). */
const CORNER_COLOR = "#ff2d2d";
/**
 * Zones à problème (réglées dans les options : par défaut ==surligné==, `code`, ~~barré~~, {{à faire}}) :
 * un trait sur la ligne où elles se trouvent, large d'au moins PROBLEM_MIN_WIDTH ; et, dans la marge
 * gauche, un repère qu'aucune couleur de bande ne recouvre. Le repère, et le trait quand le texte est trop
 * comprimé pour que ses lignes se distinguent, ne font pas moins de PROBLEM_MIN_HEIGHT : une zone se voit
 * même dans une note si longue que sa ligne n'y fait plus un pixel.
 */
const PROBLEM_MIN_HEIGHT = 2;
const PROBLEM_MIN_WIDTH = 3;
const PROBLEM_TICK_X = 1;

/**
 * Un bloc de la note, tel que la minipage le pose : une ligne du texte (ou, si du texte y est replié,
 * les lignes qu'il replie), ou une ligne vide en style « Bloc plein ». Hauteurs et rangées viennent du
 * seul texte, jamais des hauteurs de CM6 : voir StackModel.
 */
interface Block extends ModelItem {
	blank: boolean;
	/** Numéro de la ligne du texte où le bloc commence. */
	line: number;
	/** Longueur de la ligne où le bloc commence, dont on tire ses rangées. */
	length: number;
	/** Nombre de lignes à l'écran que le texte du bloc est estimé y occuper. */
	rows: number;
	/** Part de la largeur occupée par la dernière ligne à l'écran du bloc. */
	lastRowFill: number;
	/** Le bloc ouvre un paragraphe (rien avant lui, ou une ligne vide) : sa première rangée est en retrait. */
	startsRun: boolean;
	/** Le bloc achève un paragraphe (une ligne vide, ou la fin de la note, le suit). */
	endsRun: boolean;
}

/** Bloc de texte à dessiner, en coordonnées de la minipage. */
interface Band {
	/** Position du texte où le bloc commence : de quoi savoir s'il fait partie du paragraphe survolé. */
	from: number;
	top: number;
	height: number;
	rows: number;
	/** Part de la largeur occupée par la dernière ligne à l'écran du bloc. */
	lastRowFill: number;
	/** Le bloc ouvre un paragraphe (rien avant lui, ou une ligne vide) : sa première rangée est en retrait. */
	startsRun: boolean;
	color: string | undefined;
	alpha: number;
	/** Zones à reprendre du bloc, une par rangée qu'elles traversent. */
	problems: ProblemMark[];
}

/** Une zone à problème sur une rangée d'un bloc : de `start` à `end`, parts de la largeur d'une rangée. */
interface ProblemMark {
	row: number;
	start: number;
	end: number;
	color: string;
	/** Zone trop longue pour remplir sa ligne (voir `problemMaxLength`) : elle n'a que son repère dans la marge. */
	long: boolean;
}

interface Label {
	/** Haut et hauteur, dans la minipage, de la zone étiquetée : la bulle vise leur milieu, ou leur haut si la zone est plus haute qu'elle. */
	top: number;
	zoneHeight: number;
	text: string;
	color: string | undefined;
	/** Position où placer le curseur quand on clique sur la bulle : début du texte du paragraphe. */
	pos: number;
}

/** Composantes rouge, vert et bleu de `color` ("#rrggbb", "#rgb" ou "rgb(…)"), ou null si elle ne se lit pas. */
function parseRgb(color: string): number[] | null {
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
	if (hex) {
		const digits = hex[1].length === 3 ? hex[1].replace(/./g, "$&$&") : hex[1];
		return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16));
	}
	const channels = color.match(/[\d.]+/g);
	return channels && channels.length >= 3 ? channels.slice(0, 3).map(Number) : null;
}

/** Noir ou blanc, selon ce qui se lit le mieux sur `color` ("#rrggbb", "#rgb" ou "rgb(…)"). */
function contrastingTextColor(color: string): string {
	const rgb = parseRgb(color);
	if (!rgb) return "#000000";
	const brightness = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
	return brightness > 0.55 ? "#000000" : "#ffffff";
}

/** `color` tirée d'une part `share` vers `target` (mêmes notations) ; inchangée si l'une des deux ne se lit pas. */
function mixColors(color: string, target: string, share: number): string {
	const from = parseRgb(color);
	const to = parseRgb(target);
	if (!from || !to) return color;
	return `rgb(${from.map((c, i) => Math.round(c + (to[i] - c) * share)).join(", ")})`;
}

/** Rang d'un repère de section : quand la place manque, un chapitre ou un trait l'emporte sur une partie. */
function sectionRank(section: SectionBoundary): number {
	return section.level === 3 ? 0 : 1;
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
// jamais dépasser la hauteur visible. Elle a son propre modèle de hauteurs (StackModel), tiré du seul
// texte : un paragraphe long y reste proportionnellement haut, d'après sa longueur et la largeur de
// la colonne de texte. Les hauteurs de CM6, elles, ne sont exactes que pour les lignes déjà affichées
// et se corrigent au fil du défilement : les employer ferait glisser et se déformer tout ce qu'on
// dessine pendant qu'on glisse sur la minipage. On ne s'y repère donc que par des positions dans le
// texte, le modèle donnant la hauteur d'une position et inversement.
//
// En style « Paragraphes », les lignes vides n'y ont pas de hauteur, ce qui agrandit d'autant l'échelle.
class MinimapView {
	private dom: HTMLElement;
	private canvas: HTMLCanvasElement;
	private viewportEl: HTMLElement;
	private frame = 0;
	/** Pixels de minipage par pixel du modèle, recalculé à chaque dessin (0 si masquée). */
	private scale = 0;
	/** Les blocs de la note et leurs hauteurs, refaits à chaque dessin. */
	private model = new StackModel<Block>([]);
	private contentHeight = 0;
	/** Bandes et pages cornées de la dernière mise en page : de quoi repeindre le canevas sans la refaire. */
	private bands: Band[] = [];
	private corners: number[] = [];
	/** Texte du paragraphe que la minipage dessine sous le pointeur, ou d'une bulle ou d'un repère qu'il survole. */
	private hover: { from: number; to: number } | null = null;
	private bubbleLayer: HTMLElement;
	private bubbleEls: HTMLElement[] = [];
	/**
	 * Vue des bulles : 1, chacune en face de son paragraphe ; 2, toutes sur une même verticale, à
	 * intervalles réguliers, tant que la touche Ctrl est enfoncée pendant le survol.
	 */
	private bubbleView: 1 | 2 = 1;
	/** Ce que renderBubbles a reçu au dernier dessin : de quoi changer de vue sans refaire la mise en page. */
	private bubbleInput: { labels: Label[]; maxHeight: number; sectionWidth: number } | null = null;
	/** Repères des frontières de sections, en colonne contre le bord gauche de la minipage. */
	private sectionLayer: HTMLElement;
	private sectionEls: HTMLElement[] = [];
	/** Cadre de l'aperçu du paragraphe survolé, son numéro de ligne, et son texte, coupé par des points de suspension. */
	private preview: HTMLElement;
	private previewLine: HTMLElement;
	private previewText: HTMLElement;
	/** Sections de la note, et le texte d'où elles ont été relevées : un doc CM6 est immuable. */
	private sectionDoc: Text | null = null;
	private sections: SectionBoundary[] = [];
	/** Zones à reprendre de la note, et le texte d'où elles ont été relevées. */
	private problemDoc: Text | null = null;
	private problemKey = "";
	private problems: ProblemSpan[] = [];
	/** Bande jaune du paragraphe qui clignote, et ce paragraphe tant que dure son animation. */
	private flashEl: HTMLElement;
	private flashed: { from: number; to: number } | null = null;
	private flashTimer = 0;
	private dragging = false;
	/** Molette : reliquat pas encore converti en cran, taille mesurée d'un cran, paragraphe atteint. */
	private wheelDelta = 0;
	private wheelNotch = 0;
	private stepIndex: number | null = null;
	/** Mot tapé dans la barre de recherche d'Obsidian (Ctrl+F), et les blocs où il apparaît. */
	private search: SearchWatcher;

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
		// Dans la minipage (et non à côté) pour que survoler une bulle ou un repère de section compte
		// comme survoler la minipage.
		this.bubbleLayer = this.dom.createDiv({ cls: "mn-minimap-bubbles" });
		this.sectionLayer = this.dom.createDiv({ cls: "mn-minimap-sections" });
		view.dom.appendChild(this.dom);
		// À côté de la minipage et non dedans : il ne doit pas compter comme survolé, ni la recouvrir.
		this.preview = view.dom.createDiv({ cls: "mn-preview" });
		this.previewLine = this.preview.createDiv({ cls: "mn-preview-line" });
		this.previewText = this.preview.createDiv({ cls: "mn-preview-text" });
		this.preview.hide();

		this.dom.addEventListener("pointerdown", this.onPointerDown);
		this.dom.addEventListener("pointermove", this.onPointerMove);
		this.dom.addEventListener("pointerup", this.onPointerUp);
		this.dom.addEventListener("pointercancel", this.onPointerUp);
		this.dom.addEventListener("contextmenu", this.onContextMenu);
		this.dom.addEventListener("wheel", this.onWheel, { passive: false });
		this.dom.addEventListener("pointerenter", this.onPointerEnter);
		this.dom.addEventListener("pointerleave", this.onPointerLeave);
		view.scrollDOM.addEventListener("scroll", this.onScroll);
		this.search = new SearchWatcher(view, () => this.schedule());
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
				this.hover = null;
			}
			this.schedule();
		}
	}

	destroy() {
		cancelAnimationFrame(this.frame);
		window.clearTimeout(this.flashTimer);
		this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
		this.stopWatchingCtrl();
		this.search.destroy();
		this.reserveSpace(false);
		this.dom.remove();
		this.preview.remove();
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

	private hide() {
		this.scale = 0;
		this.hover = null;
		this.preview.hide();
		this.reserveSpace(false);
		this.dom.hide();
	}

	private draw() {
		const { view } = this;
		const editorHeight = view.dom.clientHeight;
		// Seulement dans l'éditeur principal d'une note (pas dans les éditeurs intégrés au canevas,
		// aux fenêtres de survol…) ; l'éditeur est aussi présent mais masqué en mode lecture.
		const inNote = view.dom.closest('.workspace-leaf-content[data-type="markdown"]') !== null;
		if (!this.plugin.settings.showMinimap || !inNote || editorHeight === 0) return this.hide();

		const lineHeight = view.defaultLineHeight;
		this.model = this.buildModel(lineHeight);
		// Une note sans texte : rien à dessiner.
		if (this.model.total === 0) return this.hide();
		this.reserveSpace(true);
		this.dom.show();

		const insets = scrollbarInsets(view.dom);
		const available = Math.max(1, editorHeight - insets.top - insets.bottom);
		this.scale = Math.min(available / this.model.total, MAX_ROW_HEIGHT / lineHeight);
		this.contentHeight = Math.floor(this.model.total * this.scale);

		const { bands, labels, corners } = this.layout();

		const height = this.contentHeight;
		const ratio = window.devicePixelRatio || 1;
		this.dom.style.top = `${insets.top}px`;
		this.dom.style.height = `${height}px`;
		this.canvas.width = Math.round(WIDTH * ratio);
		this.canvas.height = Math.round(height * ratio);
		this.canvas.style.width = `${WIDTH}px`;
		this.canvas.style.height = `${height}px`;
		// Les repères de sections d'abord : leur largeur mesurée dit de combien les bulles s'écartent.
		const sectionWidth = this.renderSections(available);
		this.dom.style.setProperty("--mn-section-width", `${sectionWidth}px`);
		this.bubbleInput = { labels, maxHeight: available, sectionWidth };
		this.renderBubbles();

		this.bands = bands;
		this.corners = corners;
		this.paint();
		this.applyHover();
		this.updateViewport();
		this.placeFlash();
	}

	/** Peint le canevas d'après la dernière mise en page : de quoi changer le paragraphe survolé sans la refaire. */
	private paint() {
		const ctx = this.canvas.getContext("2d");
		if (!ctx) return;
		const ratio = window.devicePixelRatio || 1;
		ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		ctx.clearRect(0, 0, WIDTH, this.contentHeight);
		const textColor = getComputedStyle(this.view.contentDOM).color;
		this.paintMatches(ctx);
		this.paintBands(ctx, this.bands, textColor, ratio);
		this.paintProblems(ctx, this.bands, ratio);
		this.paintCorners(ctx, this.corners);
	}

	/** Réglage « Paragraphes » (sans ligne vide, chaque paragraphe se reconnaît à sa forme) plutôt que « Bloc plein ». */
	private get byParagraph(): boolean {
		return this.plugin.settings.minimapStyle !== "block";
	}

	/** Nombre de caractères que la colonne de texte tient sur une rangée : ce qui dit combien de rangées demande une ligne. */
	private get charsPerRow(): number {
		return Math.max(1, this.view.contentDOM.clientWidth / this.view.defaultCharacterWidth);
	}

	/**
	 * Les blocs de la note et leur hauteur, d'après le seul texte. Le nombre de rangées est celui que la
	 * longueur de la première ligne du bloc demande à la largeur de la colonne : sans compter le retour à
	 * la ligne entre les mots, le texte que le mode aperçu masque, ni la taille des titres. L'erreur qui en
	 * résulte est la même à chaque dessin, alors que les hauteurs de CM6 changent à chaque mesure.
	 * Seule la structure des blocs vient de CM6 (un texte replié, un widget) ; jamais leur hauteur.
	 * En style « Bloc plein », une ligne vide est un bloc d'une rangée ; en « Paragraphes », elle n'en est pas un.
	 */
	private buildModel(lineHeight: number): StackModel<Block> {
		const { view } = this;
		const doc = view.state.doc;
		const charsPerRow = this.charsPerRow;
		const keepBlanks = !this.byParagraph;
		const blocks: Block[] = [];
		let top = 0;
		// Un paragraphe est une suite de lignes non vides : la ligne vide qui suit son dernier bloc
		// l'achève, celle qui précède son premier l'ouvre.
		let last: Block | null = null;
		let afterBlank = true;

		for (let n = 1; n <= doc.lines; n++) {
			const line = doc.line(n);
			const blank = line.text.trim() === "";
			if (blank) {
				if (last) last.endsRun = true;
				last = null;
				afterBlank = true;
				if (!keepBlanks) continue;
			}
			const block = view.lineBlockAt(line.from);
			// Une ligne repliée ou remplacée par un widget partage le bloc d'une ligne précédente ; une
			// ligne vide qui en fait partie n'est pas un bloc à elle.
			if (block.from !== line.from || (blank && block.to !== line.to)) continue;
			const rows = blank ? 1 : Math.max(1, Math.ceil(line.length / charsPerRow));
			const item: Block = {
				from: block.from,
				to: block.to,
				top,
				height: rows * lineHeight,
				blank,
				line: n,
				length: line.length,
				rows,
				lastRowFill: blank ? 1 : Math.min(1, Math.max(0.15, (line.length - (rows - 1) * charsPerRow) / charsPerRow)),
				startsRun: !blank && afterBlank,
				endsRun: false,
			};
			if (!blank) {
				afterBlank = false;
				last = item;
			}
			blocks.push(item);
			top += item.height;
		}
		// La dernière ligne de la note n'est suivie d'aucune ligne vide, mais achève elle aussi un paragraphe.
		if (last) last.endsRun = true;
		return new StackModel(blocks);
	}

	/** Bandes de texte, étiquettes et pages cornées de la note, positionnées à l'échelle courante. */
	private layout(): { bands: Band[]; labels: Label[]; corners: number[] } {
		const { view, scale } = this;
		const tagged = view.state.field(this.tagField).tagged;
		const frontmatterEnd = frontmatterLastLine(view.state.doc);
		const byParagraph = this.byParagraph;
		const bands: Band[] = [];
		const labels: Label[] = [];
		/** Hauteurs, dans la minipage, des coins repliés à dessiner. */
		const corners: number[] = [];
		const problems = this.syncProblems();
		const { problemZones, problemMaxLength } = this.plugin.settings;
		const perRow = this.charsPerRow;
		let t = 0;
		let p = 0;

		for (const item of this.model.items) {
			if (item.blank) continue;
			while (t < tagged.length && tagged[t].block.to < item.from) t++;
			while (p < problems.length && problems[p].from < item.from) p++;
			const marks: ProblemMark[] = [];
			for (; p < problems.length && problems[p].from <= item.to; p++) {
				const span = problems[p];
				const color = problemZones[span.zone]?.color;
				if (color) this.markProblem(marks, span, item, perRow, color, problemMaxLength > 0 && span.to - span.from > problemMaxLength);
			}
			const zone = t < tagged.length && tagged[t].block.from <= item.from ? tagged[t] : undefined;
			const color = this.plugin.paletteColor(zone?.tag.color);
			const top = item.top * scale;
			bands.push({
				from: item.from,
				top,
				height: item.height * scale,
				rows: item.rows,
				// Même sans ligne vide dessinée, la dernière rangée se lit comme la fin d'un paragraphe.
				lastRowFill: byParagraph && item.endsRun ? Math.min(item.lastRowFill, RUN_END_FILL_MAX) : item.lastRowFill,
				startsRun: item.startsRun,
				color,
				alpha: color ? 1 : item.line <= frontmatterEnd ? FRONTMATTER_ALPHA : TEXT_ALPHA,
				problems: marks,
			});

			if (zone?.tag.corner && zone.block.from === item.from) corners.push(top);

			// Sans texte à elle, une étiquette de couleur porte le libellé de cette couleur dans la palette ;
			// une clé qui n'y est plus (donc sans couleur), ou un libellé vide, ne donne pas de bulle.
			const text = zone?.tag.text ?? (color ? this.plugin.paletteLabel(zone?.tag.color) : undefined);
			if (zone && text && zone.block.from === item.from) {
				labels.push({
					top,
					zoneHeight: this.model.bottom(zone.block.to) * scale - top,
					text,
					color,
					pos: zone.block.markerFrom + zone.matchLength,
				});
			}
		}
		return { bands, labels, corners };
	}

	/** Les zones à problème de la note, relevées seulement quand son texte ou la liste des balisages a changé. */
	private syncProblems(): ProblemSpan[] {
		const { doc } = this.view.state;
		const { problemZones } = this.plugin.settings;
		const key = problemZonesKey(problemZones);
		if (this.problemDoc !== doc || this.problemKey !== key) {
			this.problemDoc = doc;
			this.problemKey = key;
			this.problems = problemSpans(doc, problemZones);
		}
		return this.problems;
	}

	/**
	 * Ajoute à `marks` la zone `span` du bloc `item`, à la place que le modèle donne à son texte : rangée et
	 * part de la largeur d'après le décalage dans la ligne (comme le nombre de rangées, sans compter le
	 * retour à la ligne entre les mots). Une zone qui déborde du bloc, dans du texte qui y est replié,
	 * est ramenée au bout de sa première ligne : la seule que le modèle dessine.
	 */
	private markProblem(marks: ProblemMark[], span: ProblemSpan, item: Block, perRow: number, color: string, long: boolean) {
		const start = Math.min(item.length, span.from - item.from);
		const end = Math.min(item.length, Math.max(start, span.to - item.from));
		const last = item.rows - 1;
		for (let row = Math.min(last, Math.floor(start / perRow)); row <= last && row * perRow < Math.max(end, start + 1); row++) {
			marks.push({
				row,
				start: Math.max(0, start - row * perRow) / perRow,
				end: Math.min(perRow, Math.max(0, end - row * perRow)) / perRow,
				color,
				long,
			});
		}
	}

	private paintBands(ctx: CanvasRenderingContext2D, bands: Band[], textColor: string, ratio: number) {
		if (this.byParagraph) this.paintParagraphs(ctx, bands, textColor, ratio);
		else this.paintBlocks(ctx, bands, textColor);
	}

	/** Vrai si le texte à `pos` fait partie du paragraphe survolé. */
	private inHover(pos: number): boolean {
		return this.hover !== null && pos >= this.hover.from && pos <= this.hover.to;
	}

	/** Couleur et opacité de la bande ; plus soutenues si elle fait partie du paragraphe survolé. */
	private setBandStyle(ctx: CanvasRenderingContext2D, band: Band, textColor: string) {
		if (!this.inHover(band.from)) {
			ctx.fillStyle = band.color ?? textColor;
			ctx.globalAlpha = band.alpha;
		} else if (band.color) {
			// Déjà opaque : seule sa couleur peut changer.
			ctx.fillStyle = mixColors(band.color, textColor, HOVER_COLOR_MIX);
			ctx.globalAlpha = 1;
		} else {
			ctx.fillStyle = textColor;
			ctx.globalAlpha = Math.min(1, band.alpha + HOVER_ALPHA_BOOST);
		}
	}

	/** Un aplat, avec une hauteur plancher pour qu'un court paragraphe étiqueté reste visible même dans une longue note. */
	private fillFlat(ctx: CanvasRenderingContext2D, band: Band) {
		const minHeight = band.color ? MIN_ROW_HEIGHT : 1;
		ctx.fillRect(PADDING_X, band.top, WIDTH - 2 * PADDING_X, Math.max(band.height, minHeight));
	}

	/** Style « Bloc plein » : un aplat par bloc dès que ses lignes seraient trop serrées pour se distinguer. */
	private paintBlocks(ctx: CanvasRenderingContext2D, bands: Band[], textColor: string) {
		const barWidth = WIDTH - 2 * PADDING_X;
		for (const band of bands) {
			this.setBandStyle(ctx, band, textColor);
			const rowHeight = band.height / band.rows;
			if (rowHeight < MIN_ROW_HEIGHT) {
				this.fillFlat(ctx, band);
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
	 * Style « Paragraphes » : le paragraphe se reconnaît à sa forme (voir INDENT_X et RUN_END_FILL_MAX),
	 * quelle que soit la hauteur de ses rangées. Assez hautes, ce sont des barres espacées ; sinon elles se
	 * touchent et le bloc n'est plus qu'un aplat en trois morceaux : première rangée (en retrait), corps,
	 * dernière rangée (écourtée). La forme se dégrade ainsi sans à-coup quand la note s'allonge ou que
	 * l'éditeur se rétrécit, jusqu'à un pixel d'écran pour chacune des deux rangées d'extrémité.
	 */
	private paintParagraphs(ctx: CanvasRenderingContext2D, bands: Band[], textColor: string, ratio: number) {
		const barWidth = WIDTH - 2 * PADDING_X;
		const indented = this.plugin.settings.minimapIndent;
		const pixel = 1 / ratio;
		// Ordonnée ramenée sur un pixel de l'écran : autrement, les rangées de un ou deux pixels se
		// dessineraient en lignes alternativement pâles et foncées, bordées d'un halo.
		const snap = (y: number) => Math.round(y * ratio) / ratio;
		const fill = (left: number, right: number, top: number, bottom: number) => {
			if (bottom > top && right > left) ctx.fillRect(PADDING_X + left, top, right - left, bottom - top);
		};
		for (const band of bands) {
			this.setBandStyle(ctx, band, textColor);
			const rowHeight = band.height / band.rows;
			const indent = indented && band.startsRun ? INDENT_X : 0;
			const lastRight = barWidth * band.lastRowFill;

			if (rowHeight >= MIN_ROW_HEIGHT) {
				const barHeight = rowHeight * 0.6;
				const margin = (rowHeight - barHeight) / 2;
				for (let r = 0; r < band.rows; r++) {
					const top = snap(band.top + r * rowHeight + margin);
					// Au moins un pixel d'écran, même quand la barre en vaut moins.
					const bottom = Math.max(snap(band.top + (r + 1) * rowHeight - margin), top + pixel);
					fill(r === 0 ? indent : 0, r === band.rows - 1 ? lastRight : barWidth, top, bottom);
				}
				continue;
			}

			const top = snap(band.top);
			// Un court paragraphe étiqueté ne descend pas sous MIN_ROW_HEIGHT, ni un autre sous un pixel.
			const bottom = Math.max(snap(band.top + band.height), top + (band.color ? Math.ceil(MIN_ROW_HEIGHT * ratio) / ratio : pixel));
			if (band.rows === 1) {
				fill(indent, lastRight, top, bottom);
				continue;
			}
			const lastTop = Math.max(top, Math.min(snap(band.top + band.height - rowHeight), bottom - pixel));
			// Sans alinéa, la première rangée ne se distingue pas du corps.
			const firstBottom = indent ? Math.min(lastTop, Math.max(snap(band.top + rowHeight), top + pixel)) : top;
			fill(indent, barWidth, top, firstBottom);
			fill(0, barWidth, firstBottom, lastTop);
			fill(0, lastRight, lastTop, bottom);
		}
	}

	/**
	 * Zones à problème (voir problemZones.ts), par-dessus les lignes, chacune dans sa couleur : un trait là
	 * où elles se trouvent dans leur ligne, de la hauteur de la barre qu'il recouvre pour que la forme du
	 * paragraphe reste lisible, sauf pour une zone trop longue, qui l'aurait remplie ; et, dans la marge
	 * gauche, un repère qui se lit quelle que soit la couleur de la bande et qui, d'une rangée à l'autre,
	 * forme un trait continu sur toute la hauteur de la zone. Aucun des deux ne descend sous une taille
	 * minimale : une zone reste visible dans une note si longue que sa ligne n'y fait plus un pixel.
	 */
	private paintProblems(ctx: CanvasRenderingContext2D, bands: Band[], ratio: number) {
		if (!bands.some((band) => band.problems.length > 0)) return;
		const barWidth = WIDTH - 2 * PADDING_X;
		const indented = this.byParagraph && this.plugin.settings.minimapIndent;
		const pixel = 1 / ratio;
		const snap = (y: number) => Math.round(y * ratio) / ratio;
		// paintBands laisse l'opacité de sa dernière bande : un repère, lui, est toujours opaque.
		ctx.globalAlpha = 1;
		for (const band of bands) {
			const rowHeight = band.height / band.rows;
			// Comme paintParagraphs et paintBlocks : des barres espacées si les rangées sont assez hautes, sinon un aplat.
			const spaced = rowHeight >= MIN_ROW_HEIGHT;
			for (const mark of band.problems) {
				ctx.fillStyle = mark.color;
				const rowTop = band.top + mark.row * rowHeight;
				const rowBottom = rowTop + rowHeight;
				const gutterTop = snap(rowTop);
				const gutterBottom = Math.max(snap(rowBottom), gutterTop + PROBLEM_MIN_HEIGHT);
				ctx.fillRect(PROBLEM_TICK_X, gutterTop, PADDING_X - 2 * PROBLEM_TICK_X, gutterBottom - gutterTop);
				if (mark.long) continue;

				const margin = spaced ? rowHeight * 0.2 : 0;
				const top = snap(rowTop + margin);
				const bottom = Math.max(snap(rowBottom - margin), top + (spaced ? pixel : PROBLEM_MIN_HEIGHT));
				// Là où la rangée est dessinée : sa première commence en retrait, sa dernière est écourtée.
				const rowLeft = mark.row === 0 && indented && band.startsRun ? INDENT_X : 0;
				const rowRight = mark.row === band.rows - 1 ? barWidth * band.lastRowFill : barWidth;
				const left = Math.min(Math.max(mark.start * barWidth, rowLeft), barWidth - PROBLEM_MIN_WIDTH);
				const right = Math.min(barWidth, Math.max(Math.min(mark.end * barWidth, rowRight), left + PROBLEM_MIN_WIDTH));
				ctx.fillRect(PADDING_X + left, top, right - left, bottom - top);
			}
		}
	}

	/**
	 * Fond des blocs où apparaît le mot tapé dans la barre de recherche d'Obsidian (Ctrl+F). Peint sous
	 * les lignes et sur toute la largeur, il déborde dans les marges : un bloc étiqueté, dont les lignes
	 * sont opaques, y reste repérable sans perdre sa couleur.
	 */
	private paintMatches(ctx: CanvasRenderingContext2D) {
		const { view } = this;
		const hits = this.search.hits(view.state);
		if (hits.length === 0) return;
		const spans: { top: number; bottom: number }[] = [];
		for (const hit of hits) {
			const top = this.model.top(hit.from) * this.scale;
			// Même hauteur plancher que le flash, sans quoi un paragraphe court ferait à peine un pixel.
			const bottom = Math.max(this.model.bottom(hit.to) * this.scale, top + MIN_FLASH_HEIGHT);
			const last = spans[spans.length - 1];
			// Ce plancher fait parfois chevaucher deux blocs voisins : un seul rectangle, pour que
			// l'opacité ne double pas.
			if (last && top < last.bottom) last.bottom = Math.max(last.bottom, bottom);
			else spans.push({ top, bottom });
		}
		// Le canevas n'affiche aucun texte : styles.css lui donne pour couleur celle de la recherche.
		ctx.fillStyle = getComputedStyle(this.canvas).color;
		ctx.globalAlpha = SEARCH_ALPHA;
		for (const span of spans) ctx.fillRect(0, span.top, WIDTH, span.bottom - span.top);
	}

	/**
	 * Coins repliés des paragraphes cornés. Ils se dessinent dans la marge droite de la minipage, au
	 * bord de la page et non sur son texte : ils restent ainsi lisibles quelle que soit la couleur de
	 * la bande qu'ils repèrent.
	 */
	private paintCorners(ctx: CanvasRenderingContext2D, corners: number[]) {
		if (corners.length === 0) return;
		// Le canevas ne connaît pas les classes : la couleur se lit sur la minipage, où styles.css la
		// pose, pour qu'un extrait CSS puisse la changer comme le reste.
		ctx.fillStyle = getComputedStyle(this.dom).getPropertyValue("--mn-corner-color").trim() || CORNER_COLOR;
		// paintBands laisse l'opacité de sa dernière bande : un repère, lui, est toujours opaque.
		ctx.globalAlpha = 1;
		for (const top of corners) {
			ctx.beginPath();
			ctx.moveTo(WIDTH - CORNER_SIZE, top);
			ctx.lineTo(WIDTH, top);
			ctx.lineTo(WIDTH, top + CORNER_SIZE);
			ctx.closePath();
			ctx.fill();
		}
	}

	/**
	 * Bulles des étiquettes, à gauche de la minipage (au-delà des repères de sections, larges de
	 * `sectionWidth`) et par-dessus le texte. Masquées en CSS tant que la minipage n'est pas survolée,
	 * mais toujours mises en page pour pouvoir être mesurées. Selon `bubbleView`, chacune en face de son
	 * paragraphe (vue 1) ou toutes en colonne (vue 2), en deux colonnes entrelacées s'il le faut.
	 */
	private renderBubbles() {
		if (!this.bubbleInput) return;
		const { labels, maxHeight, sectionWidth } = this.bubbleInput;
		while (this.bubbleEls.length < labels.length) {
			const el = this.bubbleLayer.createDiv({ cls: "mn-bubble" });
			el.createSpan({ cls: "mn-bubble-text" });
			// Sous la bulle (voir styles.css), pour qu'elle en cache le pied : la pointe lui est ainsi raccordée.
			const tail = document.createElementNS(SVG_NS, "svg");
			tail.classList.add("mn-bubble-tail");
			tail.appendChild(document.createElementNS(SVG_NS, "polygon"));
			el.appendChild(tail);
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

		// Bulle centrée sur une zone fine, alignée sur le haut d'une zone plus haute qu'elle : d'après la
		// hauteur mesurée de la bulle, qui dépend de la police du thème et de la présence d'une bordure.
		const sizes = labels.map((label, i) => {
			const { offsetWidth: width, offsetHeight: height } = this.bubbleEls[i];
			return { center: label.top + Math.min(label.zoneHeight, height) / 2, width, height };
		});
		const column = this.bubbleView === 2;
		// Jusqu'au bord gauche de la colonne de texte, pas au-delà dans la marge.
		const maxSpread = Math.max(
			0,
			this.dom.getBoundingClientRect().left -
				this.view.contentDOM.getBoundingClientRect().left -
				sectionWidth -
				BUBBLE_TAIL_SPACE
		);
		const placements = column
			? placeColumns(sizes, {
					maxHeight,
					maxSpread,
					gap: BUBBLE_GAP,
					// Du bord d'une bulle contre la minipage au bord du texte dessiné.
					reach: BUBBLE_TAIL_SPACE + sectionWidth + PADDING_X,
					clearance: TAIL_BASE / 2,
			  })
			: placeBubbles(sizes, { maxHeight, maxSpread, gap: BUBBLE_GAP, maxNudge: BUBBLE_HEIGHT_ESTIMATE * 0.75 });

		placements.forEach((placement, i) => {
			const el = this.bubbleEls[i];
			if (!placement) {
				el.hide();
				return;
			}
			el.style.top = `${placement.top}px`;
			el.style.right = `${placement.offset + BUBBLE_TAIL_SPACE}px`;
			this.shapeTail(el, sizes[i].width, sizes[i].height, sizes[i].center - placement.top, placement.offset, sectionWidth, column);
		});
	}

	/**
	 * Pointe d'une bulle vers la bande de son paragraphe, dont elle traverse les repères de sections et,
	 * pour une bulle décalée vers la gauche de `offset`, les bulles qui la séparent de la minipage : un
	 * biseau qui s'effile de la hauteur `TAIL_BASE`, contre la bulle, à celle de `TAIL_TIP`, sur le bord
	 * du texte dans la minipage. Il prend naissance sous la bulle, qui en cache le pied, et passe sous
	 * les autres (voir styles.css). Son bout vise `targetY` (le milieu de la zone étiquetée, en
	 * coordonnées de la bulle) ; son pied reste dans la hauteur de la bulle, d'où l'obliquité d'une bulle
	 * poussée vers le bas. Trop oblique, il n'y en a pas. En colonne (vue 2), le pied part du milieu de la
	 * bulle et la pointe est inclinée autant qu'il le faut : c'est ce qui la relie à son paragraphe.
	 */
	private shapeTail(
		el: HTMLElement,
		width: number,
		height: number,
		targetY: number,
		offset: number,
		sectionWidth: number,
		column: boolean
	) {
		const baseY = column ? height / 2 : Math.min(height - TAIL_BASE / 2, Math.max(TAIL_BASE / 2, targetY));
		const tailed = column || Math.abs(targetY - baseY) <= TAIL_MAX_SLANT;
		el.toggleClass("mn-has-tail", tailed);
		if (!tailed) return;
		const join = Math.min(TAIL_JOIN, width / 2);
		const length = join + offset + BUBBLE_TAIL_SPACE + sectionWidth + PADDING_X;
		// Repères relatifs au pied du biseau, dans la bulle : x depuis `width - join`, y depuis `top`.
		const top = Math.min(baseY - TAIL_BASE / 2, targetY - TAIL_TIP / 2);
		const bottom = Math.max(baseY + TAIL_BASE / 2, targetY + TAIL_TIP / 2);
		const svg = el.lastElementChild as SVGElement;
		// Les positions se prennent depuis le bord intérieur de la bordure de la bulle.
		svg.style.left = `${width - join - el.clientLeft}px`;
		svg.style.top = `${top - el.clientTop}px`;
		svg.setAttribute("width", String(length));
		svg.setAttribute("height", String(bottom - top));
		(svg.firstElementChild as SVGElement).setAttribute(
			"points",
			[
				[0, baseY - TAIL_BASE / 2 - top],
				[0, baseY + TAIL_BASE / 2 - top],
				[length, targetY + TAIL_TIP / 2 - top],
				[length, targetY - TAIL_TIP / 2 - top],
			]
				.map((point) => point.join(","))
				.join(" ")
		);
	}

	/**
	 * Frontières de sections de la note, et contenu de leurs repères : une étoile pour un trait de
	 * séparation ; pour un titre, son numéro dans un rond suivi du début du titre. Refaits seulement
	 * quand le texte de la note a changé.
	 */
	private syncSections(): SectionBoundary[] {
		const { doc } = this.view.state;
		if (this.sectionDoc === doc) return this.sections;
		this.sectionDoc = doc;
		this.sections = allSections(this.view.state);
		while (this.sectionEls.length < this.sections.length) {
			const el = this.sectionLayer.createDiv({ cls: "mn-section" });
			el.createSpan({ cls: "mn-section-badge" });
			el.createSpan({ cls: "mn-section-title" });
			this.sectionEls.push(el);
		}
		while (this.sectionEls.length > this.sections.length) this.sectionEls.pop()?.remove();

		// Numérotés 1, 2… pour les titres de niveau 2, et 1.1, 1.2… pour ceux de niveau 3.
		let chapter = 0;
		let part = 0;
		this.sections.forEach((section, i) => {
			if (section.level === 2) {
				chapter++;
				part = 0;
			} else if (section.level === 3) {
				part++;
			}
			const el = this.sectionEls[i];
			const badge = el.firstElementChild as HTMLElement;
			badge.textContent = section.level === 0 ? RULE_BADGE : section.level === 2 ? String(chapter) : `${chapter}.${part}`;
			const title = el.lastElementChild as HTMLElement;
			title.textContent = section.title;
			el.title = section.title;
			el.dataset.pos = String(section.pos);
			// Un trait de séparation mène, au clic, à ce qui le suit, mais se tient en face de lui-même.
			el.dataset.anchor = String(section.line.from);
			el.toggleClass("mn-section-rule", section.level === 0);
		});
		return this.sections;
	}

	/**
	 * Place les repères de sections en colonne contre le bord gauche de la minipage, chacun centré sur
	 * sa frontière, ou masqué s'il ne peut l'être. Comme les bulles, ils ne sont visibles qu'au survol
	 * mais toujours mis en page pour pouvoir être mesurés. Renvoie la largeur de la colonne, dont les
	 * bulles doivent s'écarter.
	 */
	private renderSections(maxHeight: number): number {
		const sections = this.syncSections();
		// Toutes les mesures avant la moindre écriture : une seule mise en page forcée, quel que soit le
		// nombre de repères. Celui qui ne tenait pas au dessin précédent, masqué par `visibility`, reste
		// mesurable.
		const sizes = this.sectionEls.map((el) => ({ width: el.offsetWidth, height: el.offsetHeight }));

		// À l'échelle de la minipage, des titres voisins tombent à quelques pixels l'un de l'autre : chacun
		// est repoussé sous le précédent, mais d'une demi-hauteur au plus, faute de quoi il ne serait plus
		// en face de son titre, et l'écart s'accumulerait de proche en proche. Un repère qui ne trouve pas
		// de place ainsi prend celle du précédent s'il est de rang supérieur ; sinon il est masqué.
		const placed: { i: number; top: number }[] = [];
		sections.forEach((section, i) => {
			const { height } = sizes[i];
			const block = this.model.itemAt(section.line.from);
			const center = block ? (block.top + block.height / 2) * this.scale : 0;
			const ideal = Math.min(maxHeight - height, Math.max(0, center - height / 2));
			for (;;) {
				const last = placed[placed.length - 1];
				const top = last ? Math.max(ideal, last.top + sizes[last.i].height + SECTION_GAP) : ideal;
				if (top - ideal <= height / 2 && top + height <= maxHeight) {
					placed.push({ i, top });
					return;
				}
				if (!last || sectionRank(section) <= sectionRank(sections[last.i])) return;
				placed.pop();
			}
		});

		const tops = new Map(placed.map(({ i, top }) => [i, top]));
		let width = 0;
		sections.forEach((_, i) => {
			const el = this.sectionEls[i];
			const top = tops.get(i);
			el.toggleClass("mn-section-overflow", top === undefined);
			if (top === undefined) return;
			el.style.top = `${top}px`;
			width = Math.max(width, sizes[i].width);
		});
		return width ? width + SECTION_BUBBLE_GAP : 0;
	}

	/**
	 * Hauteur, dans la minipage, du texte qui se trouve à la hauteur `height` de CM6, ici celle d'un bord
	 * de la zone visible. C'est la seule lecture des hauteurs de CM6, et elle ne porte que sur des lignes
	 * affichées, donc mesurées : on y trouve la position dans le texte, que le modèle place dans la minipage.
	 */
	private yAtHeight(height: number): number {
		const { view } = this;
		const clamped = Math.min(view.lineBlockAt(view.state.doc.length).bottom, Math.max(0, height));
		const block = view.lineBlockAtHeight(clamped);
		const fraction = block.height > 0 ? Math.min(1, Math.max(0, (clamped - block.top) / block.height)) : 0;
		return this.model.y(block.from + fraction * (block.to - block.from)) * this.scale;
	}

	/** Cadre indiquant la portion de la note actuellement visible dans l'éditeur. */
	private updateViewport() {
		if (!this.scale) return;
		const { view } = this;
		const mapHeight = this.contentHeight;
		const scrolled = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
		const top = Math.min(mapHeight, Math.max(0, this.yAtHeight(scrolled)));
		const bottom = Math.min(mapHeight, Math.max(0, this.yAtHeight(scrolled + view.scrollDOM.clientHeight)));
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

		// Un clic sur une bulle ou sur un repère de section mène à ce qu'il désigne, même s'il a été
		// décalé pour ne pas en recouvrir un autre.
		const marker =
			event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(".mn-bubble, .mn-section") : null;
		if (marker) {
			const pos = Number(marker.dataset.pos);
			this.scrollToPos(pos, true);
			this.flashAt(pos);
			return;
		}

		this.dom.setPointerCapture(event.pointerId);
		this.dragging = true;
		// Pendant le glissement le texte défile sous le pointeur : ce qu'il survolait n'a plus de sens.
		this.setHover(null);
		this.jumpTo(event.clientY, true);
	};

	/**
	 * Clic droit : corner ou décorner le paragraphe visé, sans s'y rendre — voir la corne apparaître
	 * suffit. L'événement s'arrête ici : il n'a pas à ouvrir le menu contextuel d'Obsidian. (main.ts
	 * retient tout de même sa position, en phase de capture ; aucun menu d'éditeur ne s'en servira.)
	 */
	private onContextMenu = (event: MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
		if (!this.scale) return;
		// Comme au clic gauche : une bulle vise son paragraphe, où qu'elle ait été décalée.
		const bubble = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(".mn-bubble") : null;
		// Le début du bloc, et non la position proportionnelle d'un glissement : la corne doit se poser
		// sur le paragraphe de la bande visée, même si ce bloc replie plusieurs lignes.
		const pos = bubble ? Number(bubble.dataset.pos) : this.blockAtY(event.clientY)?.from ?? 0;
		const block = paragraphAt(this.view.state, pos);
		if (block) toggleCorner(this.view, block);
	};

	private onPointerMove = (event: PointerEvent) => {
		// Le pointeur qui bouge dit aussi où en est Ctrl, si sa touche a été relâchée hors de la fenêtre.
		if (event.pointerType !== "touch") this.setBubbleView(event.ctrlKey ? 2 : 1);
		if (this.dragging) this.jumpTo(event.clientY, false);
		else this.updateHover(event);
	};

	private onPointerEnter = (event: PointerEvent) => {
		if (event.pointerType === "touch") return;
		this.watchCtrl();
		this.setBubbleView(event.ctrlKey ? 2 : 1);
	};

	private onPointerUp = (event: PointerEvent) => {
		this.dragging = false;
		if (event.type === "pointerup") this.updateHover(event);
	};

	private onPointerLeave = () => {
		this.resetStepping();
		this.setHover(null);
		this.stopWatchingCtrl();
		this.setBubbleView(1);
	};

	/**
	 * Tant que le pointeur est sur la minipage, la touche Ctrl, enfoncée ou relâchée sans que le pointeur
	 * bouge, change la vue des bulles : le clavier n'atteint pas la minipage, seulement la page.
	 */
	private watchCtrl() {
		const doc = this.dom.ownerDocument;
		doc.addEventListener("keydown", this.onKey);
		doc.addEventListener("keyup", this.onKey);
	}

	private stopWatchingCtrl() {
		const doc = this.dom.ownerDocument;
		doc.removeEventListener("keydown", this.onKey);
		doc.removeEventListener("keyup", this.onKey);
	}

	private onKey = (event: KeyboardEvent) => this.setBubbleView(event.ctrlKey ? 2 : 1);

	/** Change la vue des bulles et les remet en page : les mesures de la dernière mise en page suffisent. */
	private setBubbleView(view: 1 | 2) {
		if (view === this.bubbleView) return;
		this.bubbleView = view;
		if (this.scale) this.renderBubbles();
	}

	/**
	 * Retient le paragraphe que le pointeur survole : celui que la minipage dessine sous lui, ou celui
	 * que désigne la bulle ou le repère de section qu'il survole, où que celui-ci ait été décalé.
	 * Jamais au doigt, qui ne survole rien.
	 */
	private updateHover(event: PointerEvent) {
		if (event.pointerType === "touch" || !this.scale) return;
		const marker =
			event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(".mn-bubble, .mn-section") : null;
		const index = marker
			? this.model.indexAt(Number(marker.dataset.anchor ?? marker.dataset.pos))
			: this.model.indexAtY(this.modelYAt(event.clientY));
		this.setHover(this.runAt(index));
	}

	/**
	 * Le paragraphe dessiné au bloc d'indice `index` : la suite de lignes non vides qui l'entoure, ou
	 * null pour une ligne vide (style « Bloc plein »).
	 */
	private runAt(index: number): { from: number; to: number } | null {
		const { items } = this.model;
		if (!items[index] || items[index].blank) return null;
		let first = index;
		while (first > 0 && !items[first].startsRun) first--;
		let last = index;
		while (last < items.length - 1 && !items[last].endsRun) last++;
		return { from: items[first].from, to: items[last].to };
	}

	/** Change le paragraphe survolé : repeint la minipage, et éclaire sa bulle ou son repère de section. */
	private setHover(range: { from: number; to: number } | null) {
		if (range?.from === this.hover?.from && range?.to === this.hover?.to) return;
		this.hover = range;
		this.applyHover();
		this.paint();
	}

	/** Éclaire les bulles et repères de sections du paragraphe survolé, et en montre le texte. */
	private applyHover() {
		for (const el of this.bubbleEls) el.toggleClass("mn-lit", this.inHover(Number(el.dataset.pos)));
		for (const el of this.sectionEls) el.toggleClass("mn-lit", this.inHover(Number(el.dataset.anchor)));
		this.updatePreview();
	}

	/**
	 * Cadre sur le tiers gauche de l'éditeur, aussi haut que l'éditeur le permet, avec le numéro de la ligne
	 * où commence le paragraphe survolé (celui de la marge de l'éditeur, pour le retrouver) puis le début de
	 * son texte. Le texte se coupe à la dernière ligne entière qui tient, points de suspension compris : le
	 * nombre de lignes se déduit de la hauteur du cadre, que seul le navigateur connaît.
	 */
	private updatePreview() {
		const { view, preview, previewLine, previewText, hover } = this;
		if (!hover) return preview.hide();
		const line = `Ligne ${view.state.doc.lineAt(hover.from).number}`;
		if (previewLine.textContent !== line) previewLine.textContent = line;
		const text = textWithoutMarker(view.state.doc, hover.from, Math.min(hover.to, hover.from + PREVIEW_MAX_CHARS));
		if (previewText.textContent !== text) previewText.textContent = text;

		const maxHeight = Math.max(0, view.dom.clientHeight - 2 * PREVIEW_INSET);
		preview.style.left = `${PREVIEW_INSET}px`;
		preview.style.top = `${PREVIEW_INSET}px`;
		preview.style.width = `${Math.max(PREVIEW_MIN_WIDTH, Math.round(view.dom.clientWidth / 3)) - PREVIEW_INSET}px`;
		preview.show();
		// Une ligne d'abord, pour mesurer ce que le cadre ajoute au texte (marges et bordure).
		previewText.style.setProperty("-webkit-line-clamp", "1");
		const chrome = preview.offsetHeight - previewText.offsetHeight;
		const lineHeight = parseFloat(getComputedStyle(previewText).lineHeight) || view.defaultLineHeight;
		const lines = Math.max(1, Math.floor((maxHeight - chrome) / lineHeight));
		previewText.style.setProperty("-webkit-line-clamp", String(lines));
	}

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
		const top = this.model.top(flashed.from) * this.scale;
		const bottom = this.model.bottom(flashed.to) * this.scale;
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

	/** Hauteur, dans le modèle, de ce que la minipage dessine sous le pointeur, à la hauteur `clientY`. */
	private modelYAt(clientY: number): number {
		return (clientY - this.canvas.getBoundingClientRect().top) / this.scale;
	}

	/**
	 * Bloc sous le pointeur : ce que la bande dessinée là représente. C'est une ligne à l'écran, ou
	 * plusieurs quand du texte y est replié.
	 */
	private blockAtY(clientY: number): Block | undefined {
		return this.model.itemAtY(this.modelYAt(clientY));
	}

	/**
	 * Endroit de la note qui se trouve sous le pointeur. La position visée est proportionnelle dans le
	 * bloc plutôt qu'à son début : le texte défile ainsi continûment sous le pointeur pendant un glissement.
	 * Le modèle ne dépend pas des hauteurs de CM6, qui se corrigent pendant ce glissement : un même
	 * point de la minipage vise toujours le même texte.
	 */
	private posAtY(clientY: number): number {
		return this.model.posAt(this.modelYAt(clientY));
	}

	/**
	 * Centre l'éditeur sur l'endroit de la note correspondant à `clientY`. Au clic (et non pendant un
	 * glissement, qui clignoterait à chaque mouvement), y place aussi le curseur et fait clignoter l'arrivée.
	 */
	private jumpTo(clientY: number, click: boolean) {
		const { view } = this;
		const pos = this.posAtY(clientY);
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
