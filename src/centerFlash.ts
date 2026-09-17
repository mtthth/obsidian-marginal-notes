import { EditorView, ViewPlugin } from "@codemirror/view";
import { paragraphAt } from "./paragraphs";
import { flashParagraph } from "./flash";
import { rememberScrolled } from "./navigation";

/** Délai sans nouvel événement de défilement au bout duquel le geste est considéré fini. */
const GESTURE_END_MS = 400;

/**
 * Fait clignoter le paragraphe qui passe au centre de l'écran pendant un défilement ordinaire.
 *
 * Le geste de l'utilisateur (molette, doigt) sert de condition d'entrée : beaucoup de défilements ne
 * viennent pas de lui — l'écriture qui pousse le texte vers le haut, un saut programmé depuis la
 * minipage ou une commande, l'écho d'un autre plugin — et ils feraient tous clignoter à contretemps.
 * Une fois le geste lancé, l'inertie prolonge le défilement bien après le doigt : le geste ne se
 * referme donc qu'une fois le défilement vraiment arrêté, pas à la fin du contact.
 */
class CenterFlash {
	private scrolling = false;
	private endTimer = 0;
	/** Début du dernier paragraphe passé au centre : on ne le rejoue qu'au changement. */
	private lastFrom: number | null = null;

	constructor(private view: EditorView) {
		view.scrollDOM.addEventListener("wheel", this.onGesture, { passive: true });
		view.scrollDOM.addEventListener("touchmove", this.onGesture, { passive: true });
		view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
	}

	destroy() {
		window.clearTimeout(this.endTimer);
		this.view.scrollDOM.removeEventListener("wheel", this.onGesture);
		this.view.scrollDOM.removeEventListener("touchmove", this.onGesture);
		this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
	}

	// Seulement dans l'éditeur principal d'une note, comme la minipage : pas dans les éditeurs
	// intégrés au canevas ni dans les fenêtres de survol.
	private onGesture = () => {
		this.scrolling = this.view.dom.closest('.workspace-leaf-content[data-type="markdown"]') !== null;
		// Le geste lui-même, et non le défilement qu'il produit : un centrage programmé fait défiler
		// aussi, et ne doit pas passer pour la main de l'utilisateur.
		if (this.scrolling) rememberScrolled(this.view);
	};

	private onScroll = () => {
		if (!this.scrolling) return;
		window.clearTimeout(this.endTimer);
		this.endTimer = window.setTimeout(() => (this.scrolling = false), GESTURE_END_MS);

		const { view } = this;
		const scrolled = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
		const pos = view.lineBlockAtHeight(scrolled + view.scrollDOM.clientHeight / 2).from;
		const block = paragraphAt(view.state, pos);
		// Au centre, un bloc de code ou le frontmatter : rien à faire clignoter, mais revenir ensuite
		// sur le paragraphe qu'on vient de quitter doit le rallumer.
		if (!block) {
			this.lastFrom = null;
			return;
		}
		if (block.from === this.lastFrom) return;
		this.lastFrom = block.from;
		flashParagraph(view, block.from, block.to);
	};
}

export function createCenterFlash() {
	return ViewPlugin.define((view) => new CenterFlash(view));
}
