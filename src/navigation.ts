import { Notice } from "obsidian";
import { EditorView } from "@codemirror/view";
import { paragraphAt, TaggedParagraph, taggedParagraphs, textStart } from "./paragraphs";
import { flashParagraph } from "./flash";
import type MarginalNotesPlugin from "./main";

/** Déplacement du pointeur toléré entre l'appui et le relâchement pour que ça reste un clic. */
const CLICK_SLOP = 4;

/**
 * Paragraphe sur lequel la vue a été centrée en dernier, dans chaque éditeur. Seul un centrage sur
 * un autre paragraphe l'efface : surtout pas un défilement, pour qu'on puisse partir voir ailleurs
 * puis revenir travailler dans celui-là sans que la vue saute quand on y repose le curseur.
 */
const centred = new WeakMap<EditorView, number>();

/**
 * Retient le paragraphe sur lequel la vue vient d'être centrée, d'où que vienne le centrage : la
 * minipage y mène autant qu'un clic dans le texte, et y arriver doit dispenser de l'y ramener.
 */
export function rememberCentred(view: EditorView, from: number) {
	centred.set(view, from);
}

/**
 * Le paragraphe étiqueté suivant (1) ou précédent (-1) par rapport à `head`, en revenant au début
 * (ou à la fin) du document. Le paragraphe qui contient `head` n'est jamais la cible.
 */
export function findTagTarget(tagged: TaggedParagraph[], head: number, direction: 1 | -1): TaggedParagraph | null {
	if (tagged.length === 0) return null;
	if (direction === 1) return tagged.find((t) => t.block.from > head) ?? tagged[0];
	for (let i = tagged.length - 1; i >= 0; i--) {
		if (tagged[i].block.to < head) return tagged[i];
	}
	return tagged[tagged.length - 1];
}

/** Place le curseur au début du texte du paragraphe étiqueté suivant ou précédent. */
export function jumpToTag(view: EditorView, direction: 1 | -1) {
	const target = findTagTarget(taggedParagraphs(view.state), view.state.selection.main.head, direction);
	if (!target) {
		new Notice("Aucune étiquette dans cette note.");
		return;
	}
	// Juste après le marqueur, pour que le commentaire %%mn …%% reste masqué en aperçu en direct.
	const anchor = target.block.markerFrom + target.matchLength;
	view.dispatch({
		selection: { anchor },
		effects: EditorView.scrollIntoView(anchor, { y: "center" }),
	});
	view.focus();
	rememberCentred(view, target.block.from);
}

/**
 * Extension : le premier clic dans un paragraphe le centre et le fait clignoter, comme un clic dans
 * la minipage ; les clics suivants, ceux de quelqu'un qui y travaille, ne bougent plus rien. Le
 * curseur, lui, reste là où on l'a posé. CM6 pose ces écouteurs sur contentDOM : les clics de la
 * gouttière et de la minipage, qui sont à côté, n'arrivent pas jusqu'ici.
 */
export function centerOnClick(plugin: MarginalNotesPlugin) {
	let downAt: { x: number; y: number } | null = null;
	return EditorView.domEventHandlers({
		mousedown: (event) => {
			downAt = { x: event.clientX, y: event.clientY };
		},
		click: (event, view) => {
			// Un glissement (sélection) se termine aussi par un clic, mais ne doit pas déplacer la vue.
			const dragged = !downAt || Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > CLICK_SLOP;
			downAt = null;
			if (dragged || !plugin.settings.centerOnClick) return;
			const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
			const block = pos === null ? null : paragraphAt(view.state, pos);
			if (!block) return;
			// Déjà celui du clic précédent : on y travaille, rien ne doit remuer.
			if (centred.get(view) === block.from) return;
			centred.set(view, block.from);
			view.dispatch({ effects: EditorView.scrollIntoView(textStart(block), { y: "center" }) });
			flashParagraph(view, block.from, block.to);
		},
	});
}
