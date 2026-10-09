// Marginal Notes, par Matthieu Thomas (cidrolin). Licence MIT.

import { Notice } from "obsidian";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { encodeMarker, parseMarker, refreshMarkersEffect, ParagraphTag } from "./model";
import { allParagraphs, markerText, paragraphAt, ParagraphBlock } from "./paragraphs";

// Écriture du marqueur %%mn …%% dans le texte, partagée par le menu d'étiquetage et la minipage.
// Le marqueur porte l'étiquette et la corne ensemble : chaque écriture le réécrit en entier, et
// doit donc reconduire ce qu'elle ne change pas.

/**
 * Le paragraphe `block`, relevé plus tôt (à l'ouverture d'un menu, d'une fenêtre de saisie), dans l'état
 * actuel de la note : elle a pu changer entre-temps (synchronisation, autre plugin), et ses positions ne
 * plus valoir. On le reconnaît à sa première ligne, marqueur compris : à sa place si rien n'a bougé avant
 * lui, sinon la seule tête de paragraphe identique de la note. Null s'il n'y en a pas, ou plusieurs.
 */
function currentBlock(state: EditorState, block: ParagraphBlock): ParagraphBlock | null {
	const head = block.firstLine.text;
	const here = paragraphAt(state, block.from);
	if (here && here.from === block.from && here.firstLine.text === head) return here;
	const same = allParagraphs(state).filter((candidate) => candidate.firstLine.text === head);
	return same.length === 1 ? same[0] : null;
}

/** Le paragraphe à jour, ou null après avoir prévenu qu'on ne le retrouve pas : rien n'est écrit. */
function currentOrNotice(view: EditorView, block: ParagraphBlock): ParagraphBlock | null {
	const current = currentBlock(view.state, block);
	if (!current) new Notice("Le paragraphe a changé entre-temps : rien n'a été modifié.");
	return current;
}

/** Remplace le marqueur d'un bloc à jour par celui de `newTag` (vide : le marqueur disparaît). */
function writeTag(view: EditorView, block: ParagraphBlock, newTag: ParagraphTag) {
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

/** Remplace le marqueur du bloc par celui de `newTag` (vide : le marqueur disparaît). */
export function applyTag(view: EditorView, block: ParagraphBlock, newTag: ParagraphTag) {
	const current = currentOrNotice(view, block);
	if (current) writeTag(view, current, newTag);
}

/** Corne le paragraphe, ou le décorne s'il l'était déjà, sans toucher à son étiquette. */
export function toggleCorner(view: EditorView, block: ParagraphBlock) {
	const current = currentOrNotice(view, block);
	if (!current) return;
	const existing = parseMarker(markerText(current))?.tag ?? {};
	writeTag(view, current, { ...existing, corner: existing.corner ? undefined : true });
}
