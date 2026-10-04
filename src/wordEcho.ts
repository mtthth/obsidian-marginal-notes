// Marginal Notes, par Matthieu Thomas (cidrolin). Licence MIT.

import { EditorState, Range, StateEffect, StateField, Text } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { unreadDomSelection } from "./navigation";
import { lineTextStart } from "./paragraphs";

/** Un mot : une suite de lettres et de chiffres (l'apostrophe d'une élision sépare deux mots). */
const WORD_SOURCE = "[\\p{L}\\p{N}]+";
/** En dessous de cette longueur, un mot n'est pas assez distinctif pour qu'on le repère partout. */
const MIN_KEY_LENGTH = 2;
/** Au-delà de cette longueur, un « s » ou un « x » final est une marque de pluriel qu'on ne compte pas. */
const PLURAL_MIN_LENGTH = 4;

/**
 * Ce qui rend deux mots « proches » : la même clé. Sans égard à la casse ni aux accents, et au singulier
 * comme au pluriel (« chat », « Chats »).
 */
export function echoKey(word: string): string {
	let key = word.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
	if (key.length >= PLURAL_MIN_LENGTH && /[sx]$/.test(key)) key = key.slice(0, -1);
	return key;
}

/** Clé du texte s'il n'est qu'un mot (les espaces autour ne comptent pas), sinon null. */
function tokenKey(text: string): string | null {
	const word = text.trim();
	if (!word || !new RegExp(`^${WORD_SOURCE}$`, "u").test(word)) return null;
	const key = echoKey(word);
	return key.length >= MIN_KEY_LENGTH ? key : null;
}

/**
 * Appelle `visit` pour chaque mot de clé `key` entre `from` et `to`. Comme pour la recherche, le préfixe
 * markdown d'une ligne et le marqueur %%mn …%% masqué ne comptent pas : une clé de couleur (« vert »…)
 * n'est pas du texte.
 */
function forEachEcho(doc: Text, key: string, from: number, to: number, visit: (from: number, to: number) => void) {
	const words = new RegExp(WORD_SOURCE, "gu");
	for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
		const line = doc.line(n);
		const start = lineTextStart(line);
		words.lastIndex = 0;
		const text = line.text.slice(start - line.from);
		for (let match = words.exec(text); match; match = words.exec(text)) {
			const wordFrom = start + match.index;
			const wordTo = wordFrom + match[0].length;
			if (wordTo > from && wordFrom < to && echoKey(match[0]) === key) visit(wordFrom, wordTo);
		}
	}
}

/** Le mot double-cliqué : sa clé, ou null quand rien n'est à repérer. */
const setEcho = StateEffect.define<string>();

/**
 * Clé du mot dont on repère les proches, ou null. Elle s'efface dès que le texte change ou que la
 * sélection quitte le mot : un clic ailleurs suffit à tout éteindre.
 */
export const echoField = StateField.define<string | null>({
	create: () => null,
	update(value, tr) {
		for (const effect of tr.effects) if (effect.is(setEcho)) return effect.value;
		if (value === null || tr.docChanged) return null;
		if (tr.selection) {
			const { from, to } = tr.newSelection.main;
			if (tokenKey(tr.state.sliceDoc(from, to)) !== value) return null;
		}
		return value;
	},
});

const echoCache = new WeakMap<Text, { key: string; hits: { from: number; to: number }[] }>();

/** Les mots de la note qui ont la clé retenue, dans l'ordre ; recalculés seulement quand le texte ou le mot a changé. */
export function echoHits(state: EditorState): { from: number; to: number }[] {
	const key = state.field(echoField);
	if (!key) return [];
	const cached = echoCache.get(state.doc);
	if (cached && cached.key === key) return cached.hits;
	const hits: { from: number; to: number }[] = [];
	forEachEcho(state.doc, key, 0, state.doc.length, (from, to) => hits.push({ from, to }));
	echoCache.set(state.doc, { key, hits });
	return hits;
}

const echoMark = Decoration.mark({ class: "mn-word-echo" });

/** Marque, dans la partie affichée de la note, chaque mot de la clé retenue. */
class EchoHighlighter {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = this.build(view);
	}

	update(update: ViewUpdate) {
		if (
			update.docChanged ||
			update.viewportChanged ||
			update.startState.field(echoField) !== update.state.field(echoField)
		) {
			this.decorations = this.build(update.view);
		}
	}

	private build(view: EditorView): DecorationSet {
		const key = view.state.field(echoField);
		if (!key) return Decoration.none;
		const ranges: Range<Decoration>[] = [];
		for (const { from, to } of view.visibleRanges) {
			forEachEcho(view.state.doc, key, from, to, (start, end) => ranges.push(echoMark.range(start, end)));
		}
		return Decoration.set(ranges, true);
	}
}

/**
 * Extension : un double clic sur un mot repère, dans la page (ici) et dans la minipage (voir minimap.ts),
 * tous les mots proches du sien. Aucun repère ne reste une fois la sélection ailleurs.
 */
export const wordEcho = [
	echoField,
	ViewPlugin.fromClass(EchoHighlighter, { decorations: (plugin) => plugin.decorations }),
	EditorView.domEventHandlers({
		dblclick: (event, view) => {
			const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
			const range = pos === null ? null : view.state.wordAt(pos);
			const key = range && tokenKey(view.state.sliceDoc(range.from, range.to));
			if (!key) return;
			// Au toucher, CM6 n'a pas encore relu la sélection du navigateur : voir unreadDomSelection.
			const selection = unreadDomSelection(view);
			view.dispatch({ selection, userEvent: selection && "select.pointer", effects: setEcho.of(key) });
		},
	}),
];
