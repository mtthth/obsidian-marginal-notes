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

const HEADING_RE = /^\s{0,3}#{1,6}(?:\s|$)/;
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

/** Parcourt les blocs étiquetables dans l'ordre du document ; `visit` renvoie true pour s'arrêter. */
function forEachBlock(state: EditorState, visit: (block: ParagraphBlock) => boolean | void) {
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

		if (text.trim() === "" || HR_RE.test(text)) {
			if (flush()) return;
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
