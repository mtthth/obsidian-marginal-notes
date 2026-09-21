import type { Text } from "@codemirror/state";
import { blockCloser, frontmatterLastLine } from "./paragraphs";

/**
 * Un balisage qui signale un endroit à reprendre : le texte entre `open` et `close`, sur une seule ligne,
 * dessiné dans la minipage en `color`. Sans `close`, c'est `open` qui ferme, comme `==` ou le guillemet
 * oblique du code.
 */
export interface ProblemZone {
	open: string;
	close: string;
	color: string;
}

/** Une zone à reprendre du texte, `[from, to)`, et l'indice, dans la liste des zones, du balisage qui la fait. */
export interface ProblemSpan {
	from: number;
	to: number;
	zone: number;
}

/** Ce que l'on pose par défaut : surligné, code, barré et double accolade. */
export function defaultProblemZones(): ProblemZone[] {
	return [
		{ open: "==", close: "==", color: "#e600ac" },
		{ open: "`", close: "`", color: "#00b8d4" },
		{ open: "~~", close: "~~", color: "#8fb300" },
		{ open: "{{", close: "}}", color: "#ff7a00" },
	];
}

/** Les zones enregistrées, réduites à ce qui se lit : ce que le fichier de données contient n'est pas sûr. */
export function readProblemZones(raw: unknown): ProblemZone[] {
	if (!Array.isArray(raw)) return defaultProblemZones();
	const zones: ProblemZone[] = [];
	for (const entry of raw) {
		if (typeof entry?.open !== "string") continue;
		zones.push({
			open: entry.open,
			close: typeof entry.close === "string" ? entry.close : "",
			color: typeof entry.color === "string" && entry.color ? entry.color : "#888888",
		});
	}
	return zones;
}

/** Ce qui décide des zones qu'un texte contient : de quoi savoir si celles qu'on en a relevées valent encore. */
export function problemZonesKey(zones: ProblemZone[]): string {
	return zones.map((zone) => `${zone.open}\0${zone.close}`).join("");
}

interface CompiledZone {
	index: number;
	open: string;
	close: string;
	/** Le signe dont le balisage est une suite, si `open` et `close` ne sont qu'une même suite d'un seul signe (`==`, `~~`, `` ` ``). */
	run: string | null;
}

interface Scanner {
	zones: CompiledZone[];
	/** Où un balisage peut commencer, ou un commentaire %%…%% : de quoi sauter d'un candidat à l'autre. */
	candidates: RegExp;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compile(zones: ProblemZone[]): Scanner {
	const compiled: CompiledZone[] = [];
	zones.forEach((zone, index) => {
		if (!zone.open) return;
		const close = zone.close || zone.open;
		const single = zone.open.split("").every((ch) => ch === zone.open[0]);
		compiled.push({ index, open: zone.open, close, run: single && close === zone.open ? zone.open[0] : null });
	});
	const opens = ["%%", ...compiled.map((zone) => zone.open)];
	return { zones: compiled, candidates: new RegExp(opens.map(escapeRegExp).join("|"), "g") };
}

/** Début de la première suite d'exactement `length` fois `ch` à partir de `from`, ou -1. */
function closingRun(text: string, ch: string, from: number, length: number): number {
	let start = text.indexOf(ch, from);
	while (start >= 0) {
		let end = start;
		while (text[end] === ch) end++;
		if (end - start === length) return start;
		start = text.indexOf(ch, end);
	}
	return -1;
}

/**
 * Les zones d'une ligne, en positions relatives à son début, dans l'ordre. Le premier balisage qui
 * commence l'emporte, et à égalité le premier de la liste : ce qui est balisé à l'intérieur d'une zone
 * n'est pas compté deux fois. Un commentaire %%…%% (dont le marqueur %%mn …%%) est passé sans rien donner.
 *
 * Un balisage d'un seul signe répété (`==`, `~~`, le code) s'ouvre sur une suite de ce signe, aussi longue
 * ou plus, et se ferme sur une suite exactement aussi longue : une ligne `=====` qui souligne un titre n'est
 * pas un surligné, ni des guillemets obliques sans fermeture du code. Les autres (`{{`…`}}`) se ferment à
 * la première fermeture venue. Pas de lookbehind, que des Safari plus anciens ne savent pas lire.
 */
function scanLine(text: string, scanner: Scanner): ProblemSpan[] {
	const spans: ProblemSpan[] = [];
	const re = scanner.candidates;
	// Un `g` partagé garde son `lastIndex` d'un appel à l'autre : on repart de zéro à chaque ligne.
	re.lastIndex = 0;
	for (let match = re.exec(text); match; match = re.exec(text)) {
		const at = match.index;
		if (text.startsWith("%%", at)) {
			const close = text.indexOf("%%", at + 2);
			re.lastIndex = close >= 0 ? close + 2 : at + 2;
			continue;
		}
		let next = at + 1;
		for (const zone of scanner.zones) {
			if (!text.startsWith(zone.open, at)) continue;
			let end = -1;
			if (zone.run) {
				// Au milieu d'une suite, ce n'est pas une ouverture.
				if (at > 0 && text[at - 1] === zone.run) continue;
				let length = 0;
				while (text[at + length] === zone.run) length++;
				const close = closingRun(text, zone.run, at + length, length);
				if (close >= 0) end = close + length;
				else next = Math.max(next, at + length);
			} else {
				const close = text.indexOf(zone.close, at + zone.open.length);
				if (close >= 0) end = close + zone.close.length;
			}
			if (end >= 0) {
				spans.push({ from: at, to: end, zone: zone.index });
				next = end;
				break;
			}
		}
		re.lastIndex = next;
	}
	return spans;
}

/** Les zones d'une ligne, relatives à son début : voir `scanLine`. */
export function problemSpansOfLine(text: string, zones: ProblemZone[]): ProblemSpan[] {
	return scanLine(text, compile(zones));
}

/**
 * Les zones à reprendre de la note, dans l'ordre, en positions du texte. Comme pour les paragraphes,
 * le frontmatter et les blocs de code, de maths et de commentaires sont laissés de côté : ce qu'ils
 * contiennent n'est pas du texte.
 */
export function problemSpans(doc: Text, zones: ProblemZone[]): ProblemSpan[] {
	const scanner = compile(zones);
	const spans: ProblemSpan[] = [];
	if (scanner.zones.length === 0) return spans;
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
		for (const span of scanLine(line.text, scanner)) {
			spans.push({ from: line.from + span.from, to: line.from + span.to, zone: span.zone });
		}
	}
	return spans;
}
