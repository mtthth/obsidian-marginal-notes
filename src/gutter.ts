import { EditorState, RangeSet, RangeSetBuilder, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, gutter, GutterMarker } from "@codemirror/view";
import { hasLabel, refreshMarkersEffect } from "./model";
import { paragraphAt, TaggedParagraph, taggedParagraphs } from "./paragraphs";
import { openTagMenu } from "./menu";
import type MarginalNotesPlugin from "./main";

// Une étiquette s'affiche comme un ovale vertical de la hauteur du paragraphe. Un marqueur de
// gouttière CM6 ne couvre qu'une ligne : on en pose un par ligne du bloc, et seuls le premier
// et le dernier arrondissent leurs extrémités pour que les segments forment un seul ovale.
class TagGutterMarker extends GutterMarker {
	constructor(
		private colorHex: string | undefined,
		private label: string | undefined,
		private isFirst: boolean,
		private isLast: boolean
	) {
		super();
	}

	eq(other: TagGutterMarker) {
		return (
			this.colorHex === other.colorHex &&
			this.label === other.label &&
			this.isFirst === other.isFirst &&
			this.isLast === other.isLast
		);
	}

	toDOM() {
		const el = document.createElement("div");
		el.className = "mn-gutter-marker";
		if (this.isFirst) el.classList.add("mn-first");
		if (this.isLast) el.classList.add("mn-last");
		if (this.colorHex) el.style.setProperty("--mn-color", this.colorHex);
		// Le texte de l'étiquette est affiché dans la minipage ; ici seulement en infobulle.
		if (this.label) el.setAttribute("title", this.label);
		el.createSpan({ cls: "mn-bar" });
		return el;
	}
}

export interface TagDecorations {
	tagged: TaggedParagraph[];
	markers: RangeSet<GutterMarker>;
	/** Fond coloré de chaque ligne des paragraphes étiquetés (seulement s'ils ont une couleur). */
	lines: DecorationSet;
}

function buildDecorations(state: EditorState, plugin: MarginalNotesPlugin): TagDecorations {
	const markers = new RangeSetBuilder<GutterMarker>();
	const lines = new RangeSetBuilder<Decoration>();
	const tagged = taggedParagraphs(state);
	for (const { block, tag } of tagged) {
		// Un paragraphe qui n'est que corné n'a pas d'étiquette à dessiner : sa corne est dans la minipage.
		if (!hasLabel(tag)) continue;
		const color = plugin.paletteColor(tag.color);
		const firstNumber = block.firstLine.number;
		const lastNumber = state.doc.lineAt(block.to).number;
		for (let n = firstNumber; n <= lastNumber; n++) {
			const line = state.doc.line(n);
			const isFirst = n === firstNumber;
			const isLast = n === lastNumber;
			markers.add(line.from, line.from, new TagGutterMarker(color, tag.text, isFirst, isLast));
			if (color) {
				const cls = ["mn-line-tagged", isFirst ? "mn-first" : "", isLast ? "mn-last" : ""].join(" ").trim();
				const style = `--mn-color: ${color}; --mn-bg-alpha: ${plugin.backgroundAlpha()}%`;
				lines.add(line.from, line.from, Decoration.line({ class: cls, attributes: { style } }));
			}
		}
	}
	return { tagged, markers: markers.finish(), lines: lines.finish() };
}

/** Étiquettes du document, marqueurs de gouttière et fonds de lignes, recalculés à chaque modification. */
export function createTagField(plugin: MarginalNotesPlugin) {
	return StateField.define<TagDecorations>({
		create(state) {
			return buildDecorations(state, plugin);
		},
		update(value, tr) {
			if (tr.docChanged || tr.effects.some((e) => e.is(refreshMarkersEffect))) {
				return buildDecorations(tr.state, plugin);
			}
			return value;
		},
		provide: (field) => EditorView.decorations.from(field, (value) => value.lines),
	});
}

export function createGutter(plugin: MarginalNotesPlugin, tagField: StateField<TagDecorations>) {
	return gutter({
		class: "mn-gutter",
		markers: (view) => view.state.field(tagField).markers,
		domEventHandlers: {
			click: (view: EditorView, line, event) => {
				const block = paragraphAt(view.state, line.from);
				if (!block) return false;
				openTagMenu(plugin, view, block, event as MouseEvent);
				return true;
			},
		},
	});
}
