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
// Élément de liste : son retrait, sa puce ou son numéro, puis les blancs qui mènent à son texte.
const LIST_ITEM_RE = /^[ \t]*([-*+]|\d{1,9}[.)])([ \t]+|$)/;

/** Colonne du premier caractère qui n'est pas un blanc : une tabulation mène au multiple de quatre suivant. */
function indentColumn(text: string): number {
	let column = 0;
	for (const ch of text) {
		if (ch === " ") column++;
		else if (ch === "\t") column += 4 - (column % 4);
		else break;
	}
	return column;
}

/**
 * L'élément de liste que la ligne ouvre, ou null. `content` : la colonne où commence son texte, celle où
 * s'alignent les blocs qui le continuent (2 pour `- `, 3 pour `1. `, plus le retrait de la puce, `indent`).
 * `interrupts` : il peut couper un paragraphe pour ouvrir une liste, ce que ne fait ni un élément vide ni
 * une liste numérotée qui ne commence pas à 1.
 */
function listItem(text: string, indent: number): { content: number; interrupts: boolean } | null {
	const item = LIST_ITEM_RE.exec(text);
	if (!item) return null;
	const marker = indent + item[1].length;
	let column = marker;
	for (const ch of item[2]) column = ch === "\t" ? column + 4 - (column % 4) : column + 1;
	const empty = text.slice(item[0].length).trim() === "";
	const interrupts = !empty && (/^[-*+]$/.test(item[1]) || /^0*1[.)]$/.test(item[1]));
	// Rien après la puce, ou plus de quatre colonnes de blanc (le texte est alors du code dans l'élément) :
	// le contenu commence une colonne après la puce.
	return { content: empty || column - marker > 4 ? marker + 1 : column, interrupts };
}

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
function blockCloser(text: string): RegExp | null {
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

/** Intervalle de lignes, par leurs numéros, premier et dernier compris. */
type LineRange = readonly [number, number];

/**
 * Découpage d'un texte, chaque liste dans l'ordre : ses blocs étiquetables, ses traits horizontaux, et ses
 * lignes qui ne sont pas du texte (frontmatter, blocs de code, de maths et de commentaires, code en retrait).
 */
interface Scan {
	blocks: readonly ParagraphBlock[];
	separators: readonly Line[];
	nonText: readonly LineRange[];
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
		const nonText: LineRange[] = [];
		forEachBlock(
			doc,
			(block) => blocks.push(block),
			(line) => separators.push(line),
			(first, last) => nonText.push([first, last])
		);
		found = { blocks, separators, nonText };
		scans.set(doc, found);
	}
	return found;
}

/**
 * Parcourt les blocs étiquetables dans l'ordre du document, les traits horizontaux croisés en chemin, et
 * les intervalles de lignes qui ne sont pas du texte.
 *
 * Un bloc en retrait de quatre colonnes ou plus par rapport à ce qui le contient (la marge, ou le texte de
 * l'élément de liste qu'il continue) est du code, comme en CommonMark : il n'est pas visité, sans quoi le
 * marqueur s'y lirait en clair.
 */
function forEachBlock(
	doc: Text,
	visit: (block: ParagraphBlock) => void,
	onSeparator: (line: Line) => void,
	onNonText: (first: number, last: number) => void
) {
	let closer: RegExp | null = null;
	/**
	 * Ligne qui a ouvert le bloc à ignorer en cours. Pour un bloc de code délimité, la colonne de ce qui le
	 * contient (la marge, ou le texte d'un élément de liste) : sa fermeture n'a pas plus de trois colonnes de
	 * retrait au-delà, et dans un élément de liste, il finit avec l'élément. Null pour un autre bloc.
	 */
	let openedAt = 0;
	let openedIn: number | null = null;
	let first: Line | null = null;
	let last: Line | null = null;
	/** Le bloc en cours est du code en retrait, et la colonne que ses lignes doivent atteindre pour en être. */
	let indentedCode = false;
	let codeColumn = 0;
	/**
	 * Les éléments de liste ouverts, du plus extérieur au plus intérieur : la colonne du texte de chacun. Une
	 * ligne au moins aussi en retrait que ce texte continue l'élément ; un bloc moins en retrait le ferme.
	 */
	const items: number[] = [];
	const frontmatterEnd = frontmatterLastLine(doc);
	if (frontmatterEnd > 0) onNonText(1, frontmatterEnd);

	const flush = () => {
		if (!first || !last) return;
		if (indentedCode) onNonText(first.number, last.number);
		const offset = indentedCode ? null : markerOffset(first.text);
		if (offset !== null) visit({ from: first.from, to: last.to, firstLine: first, markerFrom: first.from + offset });
		first = last = null;
		indentedCode = false;
	};

	for (let n = frontmatterEnd + 1; n <= doc.lines; n++) {
		const line = doc.line(n);
		const text = line.text;

		if (closer) {
			const column = indentColumn(text);
			if (closer.test(text) && (openedIn === null || column < openedIn + 4)) {
				closer = null;
				onNonText(openedAt, n);
				continue;
			}
			// Un bloc de code ouvert dans un élément de liste finit avec l'élément, à la première ligne moins en
			// retrait que son texte, qui se lit alors comme les autres.
			if (!openedIn || text.trim() === "" || column >= openedIn) continue;
			closer = null;
			onNonText(openedAt, n - 1);
		}

		const column = indentColumn(text);

		// Dans du code en retrait, une ligne assez en retrait en est le contenu, quoi qu'elle porte (```, $$…).
		if (indentedCode && column >= codeColumn) {
			last = line;
			continue;
		}

		// Les éléments dont la ligne atteint le texte, et la colonne de celui qui la contient (la marge sinon) :
		// quatre colonnes au-delà, c'est du code.
		let depth = items.length;
		while (depth > 0 && column < items[depth - 1]) depth--;
		const base = depth > 0 ? items[depth - 1] : 0;
		const indented = column >= base + 4;

		// Une ligne en retrait de quatre colonnes n'ouvre pas de bloc à ignorer (```, $$, %%) : elle ouvre du
		// code en retrait, ou continue le paragraphe en cours.
		const opener: RegExp | null = indented ? null : blockCloser(text);
		if (opener) {
			flush();
			items.length = depth;
			closer = opener;
			openedAt = n;
			openedIn = FENCE_RE.test(text) ? base : null;
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
			items.length = depth;
			onSeparator(line);
			continue;
		}

		if (HEADING_RE.test(text)) {
			flush();
			items.length = depth;
			first = last = line;
			flush();
			continue;
		}

		// Un élément de liste, qui s'ouvre dans celui qui le contient (ou dans la marge).
		const item = indented ? null : listItem(text, column);
		if (!first) {
			first = line;
			// Un bloc ferme les éléments dont il n'atteint pas le texte.
			items.length = depth;
			indentedCode = indented;
			codeColumn = base + 4;
			if (item) items.push(item.content);
		} else if (item && (depth < items.length || item.interrupts || /^[ \t]*>/.test(first.text))) {
			// Dans un bloc, une ligne moins en retrait que le texte de l'élément en reste la suite, sauf à ouvrir
			// un élément : le suivant de la liste, une liste qui coupe le paragraphe qui la précède, ou n'importe
			// quelle liste après une citation, qui ne s'y prolonge pas.
			items.length = depth;
			items.push(item.content);
		} else if (!indented && /^[ \t]*>/.test(text)) {
			// Une citation coupe le texte qui la précède, et ferme les éléments dont elle n'atteint pas le texte.
			items.length = depth;
		}
		last = line;
	}
	flush();
	if (closer) onNonText(openedAt, doc.lines);
}

/**
 * Les lignes de la note qui ne sont pas du texte, en intervalles [premier, dernier] de numéros de ligne,
 * dans l'ordre : frontmatter, blocs de code (délimités ou en retrait), de maths et de commentaires.
 */
export function nonTextLines(doc: Text): readonly LineRange[] {
	return scan(doc).nonText;
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
