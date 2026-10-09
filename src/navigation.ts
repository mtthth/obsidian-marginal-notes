// Marginal Notes, par Matthieu Thomas (cidrolin). Licence MIT.

import { Notice } from "obsidian";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { hasLabel } from "./model";
import { paragraphAt, TaggedParagraph, taggedParagraphs, textStart } from "./paragraphs";
import { flashParagraph } from "./flash";
import type MarginalNotesPlugin from "./main";

/** Déplacement du pointeur toléré entre l'appui et le relâchement pour que ça reste un clic. */
const CLICK_SLOP = 4;

/** Marge laissée au-dessus d'un paragraphe amené en haut de la page. */
const TOP_MARGIN = 16;

/**
 * Attente avant de centrer au clic : le délai que CodeMirror accorde à un second appui pour en faire un
 * double clic, qui sélectionne un mot. Centrer dès le premier clic ferait défiler le texte sous le
 * pointeur, et le second appui tomberait sur un autre mot.
 */
const DOUBLE_CLICK_MS = 400;

/**
 * Défilement qui amène `pos` en haut de l'éditeur, et non au milieu : le paragraphe visé se lit alors
 * d'un trait, avec la suite de la page sous les yeux.
 */
export function scrollToTop(pos: number) {
	return EditorView.scrollIntoView(pos, { y: "start", yMargin: TOP_MARGIN });
}

/**
 * Paragraphe sur lequel la vue a été positionnée en dernier, dans chaque éditeur. Seul un centrage sur
 * un autre paragraphe l'efface : surtout pas un défilement, pour qu'on puisse partir voir ailleurs
 * puis revenir travailler dans celui-là sans que la vue saute quand on y repose le curseur.
 */
const centred = new WeakMap<EditorView, number>();

/**
 * Vues où l'utilisateur vient de faire défiler le texte lui-même. Y cliquer ne centre rien : il est
 * allé jusque-là exprès, pour y chercher quelque chose, et la vue doit rester là où il l'a posée.
 * Le drapeau se consomme à ce clic ; la suite retrouve le comportement ordinaire.
 */
const scrolledTo = new WeakSet<EditorView>();

/** Centrage d'un clic, dans chaque éditeur, qui attend de savoir si un second appui en fait un double clic. */
const pendingCentring = new WeakMap<EditorView, number>();

function cancelPendingCentring(view: EditorView) {
	window.clearTimeout(pendingCentring.get(view));
	pendingCentring.delete(view);
}

/**
 * Retient le paragraphe sur lequel la vue vient d'être centrée, d'où que vienne le centrage : la
 * minipage y mène autant qu'un clic dans le texte, et y arriver doit dispenser de l'y ramener.
 */
export function rememberCentred(view: EditorView, from: number) {
	centred.set(view, from);
	// La vue vient d'être placée pour lui : ce n'est plus lui qui a fait défiler jusque-là, et le
	// centrage d'un clic resté en attente la ramènerait ailleurs.
	scrolledTo.delete(view);
	cancelPendingCentring(view);
}

/** Signale un défilement fait à la main, par la molette ou au doigt. */
export function rememberScrolled(view: EditorView) {
	scrolledTo.add(view);
	// Le texte qu'il est allé chercher ne doit pas lui être retiré par le centrage d'un clic en attente.
	cancelPendingCentring(view);
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
	const labelled = taggedParagraphs(view.state).filter((t) => hasLabel(t.tag));
	const target = findTagTarget(labelled, view.state.selection.main.head, direction);
	if (!target) {
		new Notice("Aucune étiquette dans cette note.");
		return;
	}
	// Juste après le marqueur, pour que le commentaire %%mn …%% reste masqué en aperçu en direct.
	const anchor = target.block.markerFrom + target.matchLength;
	view.dispatch({
		selection: { anchor },
		effects: scrollToTop(anchor),
	});
	view.focus();
	rememberCentred(view, target.block.from);
}

/**
 * La sélection que le navigateur vient de poser dans le texte, si CodeMirror ne l'a pas encore relue.
 *
 * Au toucher, CodeMirror laisse le navigateur placer le curseur et ne relit la sélection qu'à
 * l'événement selectionchange, qui arrive après le clic. Une transaction envoyée entre-temps lui fait
 * remettre dans la page sa sélection d'avant — le début de la note, si on vient de l'ouvrir — et la
 * vue y saute dès que le clavier apparaît. Il faut donc la lui transmettre avec la transaction.
 */
export function unreadDomSelection(view: EditorView): EditorSelection | undefined {
	const dom = view.dom.ownerDocument.getSelection();
	if (!dom?.anchorNode || !dom.focusNode) return undefined;
	if (!view.contentDOM.contains(dom.anchorNode) || !view.contentDOM.contains(dom.focusNode)) return undefined;
	const anchor = view.posAtDOM(dom.anchorNode, dom.anchorOffset);
	const head = view.posAtDOM(dom.focusNode, dom.focusOffset);
	const { main } = view.state.selection;
	return main.anchor === anchor && main.head === head ? undefined : EditorSelection.single(anchor, head);
}

/**
 * Extension : le premier clic dans un paragraphe l'amène en haut et le fait clignoter, comme un clic dans
 * la minipage ; les clics suivants, ceux de quelqu'un qui y travaille, ne bougent plus rien. Sauf
 * quand on vient d'y arriver en faisant défiler soi-même : le clic adopte alors le paragraphe sans
 * rien déplacer. Le curseur, lui, reste toujours là où on l'a posé. CM6 pose ces écouteurs sur
 * contentDOM : les clics de la gouttière et de la minipage, qui sont à côté, n'arrivent pas jusqu'ici.
 *
 * Le centrage attend DOUBLE_CLICK_MS : un second appui l'annule, et le double clic, qui sélectionne un
 * mot, adopte le paragraphe sans déplacer la vue. Un clic avec Maj (qui étend la sélection), Ctrl, Alt
 * ou Cmd (qui ouvrent un lien, ajoutent un curseur) ne centre rien non plus.
 */
export function centerOnClick(plugin: MarginalNotesPlugin) {
	let downAt: { x: number; y: number } | null = null;
	return EditorView.domEventHandlers({
		mousedown: (event, view) => {
			downAt = { x: event.clientX, y: event.clientY };
			cancelPendingCentring(view);
		},
		click: (event, view) => {
			// Un glissement (sélection) se termine aussi par un clic, mais ne doit pas déplacer la vue.
			const dragged = !downAt || Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > CLICK_SLOP;
			downAt = null;
			const modified = event.shiftKey || event.ctrlKey || event.altKey || event.metaKey;
			if (dragged || modified || event.detail > 1 || !plugin.settings.centerOnClick) return;
			const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
			const block = pos === null ? null : paragraphAt(view.state, pos);
			if (!block) return;
			// Déjà celui du clic précédent : on y travaille, rien ne doit remuer.
			if (centred.get(view) === block.from) return;
			// Arrivé là en faisant défiler : le paragraphe devient celui où l'on travaille, mais sans
			// que la vue bouge. Un clic ailleurs, ensuite, le remontera comme d'habitude.
			const arrivedByScroll = scrolledTo.delete(view);
			centred.set(view, block.from);
			if (arrivedByScroll) return;
			const doc = view.state.doc;
			pendingCentring.set(
				view,
				window.setTimeout(() => {
					pendingCentring.delete(view);
					// Le texte a changé depuis le clic (on s'est mis à écrire) : la vue ne doit plus bouger,
					// et les positions du paragraphe ne valent plus.
					if (!view.dom.isConnected || view.state.doc !== doc) return;
					const selection = unreadDomSelection(view);
					view.dispatch({
						selection,
						userEvent: selection && "select.pointer",
						effects: scrollToTop(textStart(block)),
					});
					flashParagraph(view, block.from, block.to);
				}, DOUBLE_CLICK_MS)
			);
		},
	});
}
