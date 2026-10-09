// Marginal Notes, par Matthieu Thomas (cidrolin). Licence MIT.

import { EditorState, Line, Text } from "@codemirror/state";
import { hasLabel, parseMarker, ParagraphTag } from "./model";

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
// Ligne de `=` ou de `-` qui, juste sous un paragraphe ordinaire, le souligne en titre (setext) :
// niveau 1 pour `=`, 2 pour `-`.
const SETEXT_RE = /^\s{0,3}(=+|-+)\s*$/;
// Ouverture d'un bloc de code : trois backticks ou trois tildes au moins. Une ouverture de backticks n'en
// contient pas d'autres sur sa ligne : « ```x``` texte » est du code en ligne, pas un bloc.
const FENCE_RE = /^\s*(?:(`{3,})[^`]*|(~{3,}).*)$/;
// Préfixe (citations, puis titre, puce, liste numérotée, case à cocher) après lequel insérer le
// marqueur, pour ne pas casser la syntaxe de la ligne. Les citations se cumulent avec le reste :
// dans `> - élément`, le marqueur va après la puce.
const PREFIX_RE = /^\s*(?:>\s*)*(?:#{1,6}\s+|(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?)?/;
// Ce qu'un marqueur en tête casserait : un tableau, un en-tête de callout, une définition de note de
// bas de page (`[^1]: …`) ou de lien (`[ref]: adresse "titre"`), une case à cocher sans texte
// (`- [ ]`, qui n'en serait plus une avec le marqueur collé à son crochet).
const UNTAGGABLE_RE = /^(?:\||\[!|\[\^[^\]]+\]:|\[[^\]]+\]:\s*\S+(?:\s+["'(].*)?$|\[.\]$)/;
// Retrait d'au moins quatre colonnes : en tête de bloc et hors d'une liste, c'est du code.
const INDENTED_RE = /^(?: {4}| {0,3}\t)/;
// Élément de liste au premier niveau (trois espaces de retrait au plus).
const LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

/** Décalage du marqueur dans la première ligne d'un bloc, ou null si le bloc ne peut pas être étiqueté. */
function markerOffset(text: string): number | null {
	const offset = PREFIX_RE.exec(text)?.[0].length ?? 0;
	return UNTAGGABLE_RE.test(text.slice(offset)) ? null : offset;
}

/**
 * Vrai pour la première ligne d'un paragraphe ordinaire (ni titre, ni liste, ni citation) : le seul
 * qu'un soulignement setext change en titre.
 */
function isPlainParagraph(text: string): boolean {
	return PREFIX_RE.exec(text)?.[0].trim() === "";
}

/** Si la ligne ouvre un bloc à ignorer, renvoie le motif de sa ligne fermante. */
export function blockCloser(text: string): RegExp | null {
	const fence = FENCE_RE.exec(text);
	const run = fence && (fence[1] ?? fence[2]);
	if (run) return new RegExp(`^\\s*${run[0]}{${run.length},}\\s*$`);
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

/** Découpage d'un texte : ses blocs étiquetables et ses traits horizontaux, chacun dans l'ordre. */
interface Scan {
	blocks: readonly ParagraphBlock[];
	separators: readonly Line[];
}

/**
 * Découpage de chaque texte, refait seulement quand il change : un doc CM6 est immuable, et une même
 * version sert à la gouttière, à la minipage, au défilement, au clic… Une longue note n'est ainsi
 * parcourue qu'une fois par frappe.
 */
const scans = new WeakMap<Text, Scan>();

function scan(doc: Text): Scan {
	let found = scans.get(doc);
	if (!found) {
		const blocks: ParagraphBlock[] = [];
		const separators: Line[] = [];
		forEachBlock(doc, (block) => blocks.push(block), (line) => separators.push(line));
		found = { blocks, separators };
		scans.set(doc, found);
	}
	return found;
}

/**
 * Parcourt les blocs étiquetables dans l'ordre du document, et les traits horizontaux croisés en chemin.
 *
 * Un bloc qui commence en retrait de quatre colonnes est du code, comme en CommonMark, sauf dans une
 * liste, dont il continue un élément : il n'est pas visité, sans quoi le marqueur s'y lirait en clair.
 */
function forEachBlock(doc: Text, visit: (block: ParagraphBlock) => void, onSeparator: (line: Line) => void) {
	let closer: RegExp | null = null;
	let first: Line | null = null;
	let last: Line | null = null;
	/** Le bloc en cours est du code en retrait. */
	let indentedCode = false;
	/**
	 * On est dans une liste : elle commence à une puce ou à un numéro, et finit au premier bloc qui n'est
	 * pas en retrait et ne commence pas par l'un d'eux, à un titre, à un trait, à un bloc de code.
	 */
	let inList = false;
	const frontmatterEnd = frontmatterLastLine(doc);

	const flush = () => {
		if (!first || !last) return;
		const offset = indentedCode ? null : markerOffset(first.text);
		if (offset !== null) visit({ from: first.from, to: last.to, firstLine: first, markerFrom: first.from + offset });
		first = last = null;
		indentedCode = false;
	};

	for (let n = frontmatterEnd + 1; n <= doc.lines; n++) {
		const line = doc.line(n);
		const text = line.text;

		if (closer) {
			if (closer.test(text)) closer = null;
			continue;
		}

		// Dans du code en retrait, une ligne en retrait en est le contenu, quoi qu'elle porte (```, $$…).
		if (indentedCode && INDENTED_RE.test(text)) {
			last = line;
			continue;
		}

		// Hors d'une liste, une ligne en retrait n'ouvre pas de bloc à ignorer (```, $$, %%) : elle ouvre du
		// code en retrait, ou continue le paragraphe en cours.
		const indented = INDENTED_RE.test(text);
		const opener = indented && !inList ? null : blockCloser(text);
		if (opener) {
			flush();
			if (!indented) inList = false;
			closer = opener;
			continue;
		}

		if (text.trim() === "") {
			flush();
			continue;
		}

		// Le code en retrait s'arrête à la première ligne qui ne l'est pas : elle ouvre autre chose.
		if (indentedCode) flush();

		// Le soulignement d'un titre setext fait partie du titre : ce n'est pas un trait.
		if (first && isPlainParagraph(first.text) && SETEXT_RE.test(text)) {
			last = line;
			flush();
			continue;
		}

		if (HR_RE.test(text)) {
			flush();
			inList = false;
			onSeparator(line);
			continue;
		}

		if (HEADING_RE.test(text)) {
			flush();
			inList = false;
			first = last = line;
			flush();
			continue;
		}

		if (!first) {
			first = line;
			indentedCode = indented && !inList;
			if (!indented) inList = LIST_ITEM_RE.test(text);
		} else if (LIST_ITEM_RE.test(text)) {
			// Une liste peut suivre une ligne de texte sans ligne vide entre elles.
			inList = true;
		}
		last = line;
	}
	flush();
}

/** Vrai si le bloc est un titre : `#`… sur sa ligne, ou souligné par `===`/`---` (setext). */
export function isHeadingBlock(doc: Text, block: ParagraphBlock): boolean {
	const text = block.firstLine.text;
	if (HEADING_RE.test(text)) return true;
	return block.to > block.firstLine.to && isPlainParagraph(text) && SETEXT_RE.test(doc.lineAt(block.to).text);
}

/** Le bloc étiquetable contenant `pos`, ou null. */
export function paragraphAt(state: EditorState, pos: number): ParagraphBlock | null {
	const blocks = allParagraphs(state);
	// Le dernier bloc qui commence à `pos` ou avant : il le contient, ou `pos` tombe après lui, hors de tout bloc.
	let low = 0;
	let high = blocks.length - 1;
	let found = -1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		if (blocks[mid].from <= pos) {
			found = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return found >= 0 && pos <= blocks[found].to ? blocks[found] : null;
}

/** Tous les blocs étiquetables du document, dans l'ordre : un tableau partagé, à ne pas modifier. */
export function allParagraphs(state: EditorState): readonly ParagraphBlock[] {
	return scan(state.doc).blocks;
}

/** Texte de la première ligne du bloc à partir de l'emplacement du marqueur. */
export function markerText(block: ParagraphBlock): string {
	return block.firstLine.text.slice(block.markerFrom - block.firstLine.from);
}

/** Début du texte d'une ligne, après un éventuel préfixe markdown et un éventuel marqueur %%mn …%%. */
export function lineTextStart(line: Line): number {
	const offset = PREFIX_RE.exec(line.text)?.[0].length ?? 0;
	return line.from + offset + (parseMarker(line.text.slice(offset))?.matchLength ?? 0);
}

/** Le texte de `[from, to]`, sans le marqueur %%mn …%% que porte sa première ligne : ce n'est pas du texte. */
export function textWithoutMarker(doc: Text, from: number, to: number): string {
	const first = doc.lineAt(from);
	const markerFrom = first.from + (PREFIX_RE.exec(first.text)?.[0].length ?? 0);
	return doc.sliceString(from, markerFrom) + doc.sliceString(lineTextStart(first), to);
}

/** Début du texte du bloc, après un éventuel marqueur : où viser pour ne pas dévoiler le %%mn …%%. */
export function textStart(block: ParagraphBlock): number {
	return lineTextStart(block.firstLine);
}

export interface TaggedParagraph {
	block: ParagraphBlock;
	tag: ParagraphTag;
	/** Longueur du marqueur (espace final compris) à partir de `block.markerFrom`. */
	matchLength: number;
}

/** Les blocs du document qui portent une étiquette ou une corne (pas un marqueur vide), dans l'ordre. */
export function taggedParagraphs(state: EditorState): TaggedParagraph[] {
	const tagged: TaggedParagraph[] = [];
	for (const block of allParagraphs(state)) {
		const parsed = parseMarker(markerText(block));
		if (parsed && (parsed.tag.corner || hasLabel(parsed.tag))) tagged.push({ block, ...parsed });
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
	/** Où mener un clic : le texte du titre, ou ce qui suit le trait. */
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
 * Niveau d'un bloc titre, `## Titre` ou `Titre` souligné (setext), et la fin du texte de ce titre ;
 * null si le bloc n'est pas un titre.
 */
function headingOf(doc: Text, block: ParagraphBlock): { level: number; textEnd: number } | null {
	const atx = HEADING_RE.exec(block.firstLine.text);
	if (atx) return { level: atx[1].length, textEnd: block.to };
	// forEachBlock ne termine un paragraphe ordinaire sur une ligne non vide qu'à son soulignement.
	const underline = doc.lineAt(block.to);
	if (underline.number === block.firstLine.number || !isPlainParagraph(block.firstLine.text)) return null;
	const setext = SETEXT_RE.exec(underline.text);
	return setext ? { level: setext[1][0] === "=" ? 1 : 2, textEnd: underline.from - 1 } : null;
}

/**
 * Les frontières de sections de la note, dans l'ordre : les titres de niveau 2 et 3, et les traits
 * de séparation (`***`, `---`, `___`). Un trait ne désigne aucun texte : on y fait mener à ce qui
 * le suit, c'est-à-dire au début de la section qu'il ouvre.
 */
export function allSections(state: EditorState): SectionBoundary[] {
	const { doc } = state;
	const sections: SectionBoundary[] = [];
	let pending: SectionBoundary[] = [];
	const onBlock = (block: ParagraphBlock) => {
		const pos = textStart(block);
		const heading = headingOf(doc, block);
		const titled = heading !== null && (heading.level === 2 || heading.level === 3);
		// Un trait suivi d'un paragraphe mène à son texte, après son éventuel marqueur.
		for (const rule of pending) {
			if (rule.pos !== block.from) continue;
			// Un trait juste avant un titre le double : ils se tiendraient à la même hauteur, et le
			// repère du titre, qui ne tient pas à côté de l'étoile, disparaîtrait.
			if (titled) sections.splice(sections.indexOf(rule), 1);
			else rule.pos = pos;
		}
		pending = [];
		if (heading && titled) {
			const title = shortTitle(doc.sliceString(pos, heading.textEnd));
			sections.push({ line: block.firstLine, level: heading.level, title, pos });
		}
	};

	const onSeparator = (line: Line) => {
		// La première ligne qui suit le trait, quelle qu'elle soit : un encadré, un tableau ou un bloc
		// de code, que forEachBlock ne visite pas, ouvrent la section aussi bien qu'un paragraphe.
		// En fin de note, faute de mieux, le trait renvoie à lui-même.
		let next = line.number + 1;
		while (next <= doc.lines && (doc.line(next).text.trim() === "" || HR_RE.test(doc.line(next).text))) next++;
		const pos = next <= doc.lines ? doc.line(next).from : line.from;
		const rule: SectionBoundary = { line, level: 0, title: "", pos };
		sections.push(rule);
		pending.push(rule);
	};

	const { blocks, separators } = scan(doc);
	// Les blocs et les traits de séparation, dans l'ordre du texte : ils n'ont jamais de ligne en commun.
	let s = 0;
	for (const block of blocks) {
		while (s < separators.length && separators[s].from < block.from) onSeparator(separators[s++]);
		onBlock(block);
	}
	while (s < separators.length) onSeparator(separators[s++]);
	return sections;
}
