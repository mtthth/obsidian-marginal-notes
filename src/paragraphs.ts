import { EditorState, Line, Text } from "@codemirror/state";
import { parseMarker, ParagraphTag } from "./model";

export interface ParagraphBlock {
	from: number;
	to: number;
	firstLine: Line;
	/** Position où se trouve (ou sera inséré) le marqueur, après un éventuel préfixe markdown. */
	markerFrom: number;
}

// Obsidian n'utilise pas la grammaire Lezer markdown : son arbre syntaxique ne contient aucun
// nœud "Paragraph". On découpe donc le texte nous-mêmes en blocs séparés par des lignes vides,
// en ignorant le frontmatter, les blocs de code, de maths et de commentaires.

const HEADING_RE = /^\s{0,3}(#{1,6})(?:\s|$)/;
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
// Préfixe (titre, citation, puce, liste numérotée, case à cocher) après lequel insérer le
// marqueur, pour ne pas casser la syntaxe de la ligne.
const PREFIX_RE = /^\s*(?:#{1,6}\s+|(?:>\s?)+|(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?)?/;

/** Décalage du marqueur dans la première ligne d'un bloc, ou null si le bloc ne peut pas être étiqueté. */
function markerOffset(text: string): number | null {
	const offset = PREFIX_RE.exec(text)?.[0].length ?? 0;
	const rest = text.slice(offset);
	// Tableaux et en-têtes de callout : un marqueur en tête casserait leur rendu.
	if (rest.startsWith("|") || rest.startsWith("[!")) return null;
	return offset;
}

/** Si la ligne ouvre un bloc à ignorer, renvoie le motif de sa ligne fermante. */
function blockCloser(text: string): RegExp | null {
	const fence = FENCE_RE.exec(text);
	if (fence) return new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
	const trimmed = text.trim();
	if (trimmed.startsWith("$$") && !trimmed.slice(2).includes("$$")) return /\$\$/;
	if (trimmed.startsWith("%%") && !trimmed.slice(2).includes("%%")) return /%%/;
	return null;
}

/** Numéro de la dernière ligne du frontmatter YAML en tête de note, ou 0 s'il n'y en a pas. */
export function frontmatterLastLine(doc: Text): number {
	if (doc.lines < 2 || !/^---\s*$/.test(doc.line(1).text)) return 0;
	for (let n = 2; n <= doc.lines; n++) {
		if (/^(?:---|\.\.\.)\s*$/.test(doc.line(n).text)) return n;
	}
	return 0;
}

/**
 * Parcourt les blocs étiquetables dans l'ordre du document ; `visit` renvoie true pour s'arrêter.
 * `onSeparator`, s'il est fourni, reçoit en plus les traits horizontaux croisés en chemin.
 */
function forEachBlock(
	state: EditorState,
	visit: (block: ParagraphBlock) => boolean | void,
	onSeparator?: (line: Line) => void
) {
	const doc = state.doc;
	let closer: RegExp | null = null;
	let first: Line | null = null;
	let last: Line | null = null;
	const frontmatterEnd = frontmatterLastLine(doc);

	const flush = (): boolean => {
		if (!first || !last) return false;
		const offset = markerOffset(first.text);
		const block = { from: first.from, to: last.to, firstLine: first, markerFrom: first.from + (offset ?? 0) };
		first = last = null;
		return offset !== null && visit(block) === true;
	};

	for (let n = frontmatterEnd + 1; n <= doc.lines; n++) {
		const line = doc.line(n);
		const text = line.text;

		if (closer) {
			if (closer.test(text)) closer = null;
			continue;
		}

		const opener = blockCloser(text);
		if (opener) {
			if (flush()) return;
			closer = opener;
			continue;
		}

		if (text.trim() === "") {
			if (flush()) return;
			continue;
		}

		if (HR_RE.test(text)) {
			if (flush()) return;
			onSeparator?.(line);
			continue;
		}

		if (HEADING_RE.test(text)) {
			if (flush()) return;
			first = last = line;
			if (flush()) return;
			continue;
		}

		if (!first) first = line;
		last = line;
	}
	flush();
}

/** Le bloc étiquetable contenant `pos`, ou null. */
export function paragraphAt(state: EditorState, pos: number): ParagraphBlock | null {
	let found: ParagraphBlock | null = null;
	forEachBlock(state, (block) => {
		if (block.from > pos) return true;
		if (pos <= block.to) {
			found = block;
			return true;
		}
	});
	return found;
}

/** Tous les blocs étiquetables du document, dans l'ordre. */
export function allParagraphs(state: EditorState): ParagraphBlock[] {
	const blocks: ParagraphBlock[] = [];
	forEachBlock(state, (block) => {
		blocks.push(block);
	});
	return blocks;
}

/** Texte de la première ligne du bloc à partir de l'emplacement du marqueur. */
export function markerText(block: ParagraphBlock): string {
	return block.firstLine.text.slice(block.markerFrom - block.firstLine.from);
}

/** Début du texte du bloc, après un éventuel marqueur : où viser pour ne pas dévoiler le %%mn …%%. */
export function textStart(block: ParagraphBlock): number {
	return block.markerFrom + (parseMarker(markerText(block))?.matchLength ?? 0);
}

export interface TaggedParagraph {
	block: ParagraphBlock;
	tag: ParagraphTag;
	/** Longueur du marqueur (espace final compris) à partir de `block.markerFrom`. */
	matchLength: number;
}

/** Les blocs du document qui portent une étiquette, dans l'ordre. */
export function taggedParagraphs(state: EditorState): TaggedParagraph[] {
	const tagged: TaggedParagraph[] = [];
	for (const block of allParagraphs(state)) {
		const parsed = parseMarker(markerText(block));
		if (parsed) tagged.push({ block, ...parsed });
	}
	return tagged;
}

export interface SectionBoundary {
	/** Ligne du titre, ou du trait qui sépare deux sections. */
	line: Line;
	/** Niveau du titre (2 ou 3), ou 0 pour un trait de séparation. */
	level: number;
	/** Début du titre, abrégé pour tenir dans la marge ; vide pour un trait. */
	title: string;
	/** Où mener un clic : le texte du titre, ou le premier paragraphe qui suit le trait. */
	pos: number;
}

/** Ce qu'on garde du titre d'une section : ses premiers mots, sans dépasser tant de caractères. */
const TITLE_WORDS = 3;
const TITLE_CHARS = 30;

/** Les premiers mots d'un titre, suivis de points de suspension s'il en reste. */
function shortTitle(text: string): string {
	// Les dièses d'un titre vide, que PREFIX_RE (qui réclame une espace) n'a pas écartés, et ceux
	// dont on referme parfois un titre.
	const full = text
		.replace(/^#{1,6}(?:\s+|$)/, "")
		.replace(/\s+#+\s*$/, "")
		.replace(/\s+/g, " ")
		.trim();
	let short = full.split(" ").slice(0, TITLE_WORDS).join(" ");
	if (short.length > TITLE_CHARS) short = short.slice(0, TITLE_CHARS).trimEnd();
	return short.length < full.length ? short + "…" : short;
}

/**
 * Les frontières de sections de la note, dans l'ordre : les titres de niveau 2 et 3, et les traits
 * de séparation (`***`, `---`, `___`). Un trait ne désigne aucun texte : on y fait mener au premier
 * paragraphe qui le suit, c'est-à-dire au début de la section qu'il ouvre.
 */
export function allSections(state: EditorState): SectionBoundary[] {
	const sections: SectionBoundary[] = [];
	let pending: SectionBoundary[] = [];
	forEachBlock(
		state,
		(block) => {
			const pos = textStart(block);
			for (const rule of pending) rule.pos = pos;
			pending = [];
			const level = HEADING_RE.exec(block.firstLine.text)?.[1].length ?? 0;
			if (level === 2 || level === 3) {
				sections.push({ line: block.firstLine, level, title: shortTitle(state.doc.sliceString(pos, block.to)), pos });
			}
		},
		(line) => {
			// Tant qu'aucun paragraphe ne suit, un trait renvoie à lui-même : c'est le cas d'un trait
			// posé en fin de note.
			const rule: SectionBoundary = { line, level: 0, title: "", pos: line.from };
			sections.push(rule);
			pending.push(rule);
		}
	);
	return sections;
}
