// Marginal Notes, par Matthieu Thomas (cidrolin). Licence MIT.

import { EditorView } from "@codemirror/view";
import { encodeMarker, parseMarker, refreshMarkersEffect, ParagraphTag } from "./model";
import { markerText, ParagraphBlock } from "./paragraphs";

// Écriture du marqueur %%mn …%% dans le texte, partagée par le menu d'étiquetage et la minipage.
// Le marqueur porte l'étiquette et la corne ensemble : chaque écriture le réécrit en entier, et
// doit donc reconduire ce qu'elle ne change pas.

/** Remplace le marqueur du bloc par celui de `newTag` (vide : le marqueur disparaît). */
export function applyTag(view: EditorView, block: ParagraphBlock, newTag: ParagraphTag) {
	const existing = parseMarker(markerText(block));
	const removeLength = existing ? existing.matchLength : 0;
	view.dispatch({
		changes: {
			from: block.markerFrom,
			to: block.markerFrom + removeLength,
			insert: encodeMarker(newTag),
		},
		effects: refreshMarkersEffect.of(),
	});
}

/** Corne le paragraphe, ou le décorne s'il l'était déjà, sans toucher à son étiquette. */
export function toggleCorner(view: EditorView, block: ParagraphBlock) {
	const existing = parseMarker(markerText(block))?.tag ?? {};
	applyTag(view, block, { ...existing, corner: existing.corner ? undefined : true });
}
