import type { Text } from "@codemirror/state";
import { blockCloser, frontmatterLastLine } from "./paragraphs";

/** Une zone à reprendre : un balisage `==…==`, `` `…` ``, `~~…~~` ou `{{…}}`, sur une seule ligne. `[from, to)`. */
export interface ProblemSpan {
	from: number;
	to: number;
}

// Le premier balisage qui commence l'emporte : ce qui est balisé à l'intérieur d'un autre n'est pas
// compté deux fois. Un commentaire %%…%% (dont le marqueur %%mn …%%) est avalé sans rien donner. Le code
// est plus délicat (sa fermeture doit être une suite de guillemets obliques de même longueur que
// l'ouverture) : la regex ne repère que l'ouverture, et `closingRun` cherche la fermeture. Le contenu de
// `==` et de `~~` ne commence ni ne finit par le même signe : la ligne `=====` qui souligne un titre n'en est pas une.
// Pas de lookbehind, que des Safari plus anciens ne savent pas lire.
const SCAN_RE = /%%.*?%%|`+|==[^=]+(?:=[^=]+)*==|~~[^~]+(?:~[^~]+)*~~|\{\{.*?\}\}/g;

/** Début de la première suite d'exactement `length` guillemets obliques à partir de `from`, ou -1. */
function closingRun(text: string, from: number, length: number): number {
	let start = text.indexOf("`", from);
	while (start >= 0) {
		let end = start;
		while (text[end] === "`") end++;
		if (end - start === length) return start;
		start = text.indexOf("`", end);
	}
	return -1;
}

/** Les zones à reprendre d'une ligne, en positions relatives à son début, dans l'ordre. */
export function problemSpansOfLine(text: string): ProblemSpan[] {
	const spans: ProblemSpan[] = [];
	// Un `g` partagé garde son `lastIndex` d'un appel à l'autre : on repart de zéro à chaque ligne.
	SCAN_RE.lastIndex = 0;
	for (let match = SCAN_RE.exec(text); match; match = SCAN_RE.exec(text)) {
		const found = match[0];
		if (found.startsWith("%%")) continue;
		if (found[0] !== "`") {
			spans.push({ from: match.index, to: match.index + found.length });
			continue;
		}
		const close = closingRun(text, match.index + found.length, found.length);
		// Des guillemets obliques qu'aucun autre ne referme sont du texte.
		if (close < 0) continue;
		const to = close + found.length;
		spans.push({ from: match.index, to });
		SCAN_RE.lastIndex = to;
	}
	return spans;
}

/**
 * Les zones à reprendre de la note, dans l'ordre, en positions du texte. Comme pour les paragraphes,
 * le frontmatter et les blocs de code, de maths et de commentaires sont laissés de côté : ce qu'ils
 * contiennent n'est pas du texte.
 */
export function problemSpans(doc: Text): ProblemSpan[] {
	const spans: ProblemSpan[] = [];
	let closer: RegExp | null = null;
	for (let n = frontmatterLastLine(doc) + 1; n <= doc.lines; n++) {
		const line = doc.line(n);
		if (closer) {
			if (closer.test(line.text)) closer = null;
			continue;
		}
		const opener = blockCloser(line.text);
		if (opener) {
			closer = opener;
			continue;
		}
		for (const span of problemSpansOfLine(line.text)) spans.push({ from: line.from + span.from, to: line.from + span.to });
	}
	return spans;
}
