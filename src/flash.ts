import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";

/** À garder égal aux animations de 1,5 s de styles.css : la ligne, la bande de la minipage et les
    fonds qu'elles effacent le temps du flash. */
export const FLASH_DURATION_MS = 1500;

/** Lignes à surligner (numéros CodeMirror, à partir de 1), ou null pour effacer. */
type LineRange = { from: number; to: number } | null;

const flashEffect = StateEffect.define<LineRange>();
const flashLine = Decoration.line({ class: "mn-flash" });

/** Surlignage fugace d'un paragraphe, remplacé en bloc à chaque effet, et qui suit les modifications du texte. */
export const flashField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(decorations, tr) {
		for (const effect of tr.effects) {
			if (!effect.is(flashEffect)) continue;
			if (!effect.value) return Decoration.none;
			const doc = tr.state.doc;
			const builder = new RangeSetBuilder<Decoration>();
			for (let n = Math.min(effect.value.from, doc.lines); n <= Math.min(effect.value.to, doc.lines); n++) {
				builder.add(doc.line(n).from, doc.line(n).from, flashLine);
			}
			return builder.finish();
		}
		return decorations.map(tr.changes);
	},
	provide: (field) => EditorView.decorations.from(field),
});

const timers = new WeakMap<EditorView, number>();

/** Fait clignoter brièvement le paragraphe couvrant `from`..`to`, pour montrer où le déplacement a mené. */
export function flashParagraph(view: EditorView, from: number, to: number) {
	const doc = view.state.doc;
	window.clearTimeout(timers.get(view));
	view.dispatch({ effects: flashEffect.of({ from: doc.lineAt(from).number, to: doc.lineAt(to).number }) });
	timers.set(
		view,
		window.setTimeout(() => {
			if (view.dom.isConnected) view.dispatch({ effects: flashEffect.of(null) });
		}, FLASH_DURATION_MS)
	);
}
