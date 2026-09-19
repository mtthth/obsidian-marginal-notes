import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { SearchCursor } from "@codemirror/search";
import { allParagraphs, textStart } from "./paragraphs";

/** Portion de la note où apparaît le mot cherché : un paragraphe entier, ou une ligne hors paragraphe. */
export interface SearchHit {
	from: number;
	to: number;
}

/**
 * Blocs de la note où apparaît `query`, dans l'ordre et chacun une seule fois : le paragraphe qui
 * contient l'occurrence, ou sa seule ligne quand elle est hors de tout paragraphe (frontmatter, bloc
 * de code, tableau…). La comparaison est celle de la barre de recherche d'Obsidian — le même curseur
 * CM6, sans égard à la casse —, pour que la minipage montre exactement ce que Ctrl+F trouve.
 */
export function searchHits(state: EditorState, query: string): SearchHit[] {
	const hits: SearchHit[] = [];
	if (!query) return hits;
	const doc = state.doc;
	const blocks = allParagraphs(state);
	let b = 0;
	const cursor = new SearchCursor(doc, query, 0, doc.length, (s) => s.toLowerCase());
	while (!cursor.nextOverlapping().done) {
		const { from, to } = cursor.value;
		const last = hits[hits.length - 1];
		// Encore dans le bloc déjà retenu.
		if (last && from <= last.to) continue;
		while (b < blocks.length && blocks[b].to < from) b++;
		const block = b < blocks.length && blocks[b].from <= from ? blocks[b] : undefined;
		if (!block) {
			const line = doc.lineAt(from);
			hits.push({ from: line.from, to: line.to });
		} else if (to > textStart(block)) {
			// Une occurrence tout entière avant le texte du paragraphe, dans son préfixe markdown ou
			// dans le marqueur %%mn …%% masqué, n'en fait pas partie : les clés de couleur (« vert »,
			// « rouge »…) ne doivent pas mettre en valeur tous les paragraphes étiquetés.
			hits.push({ from: block.from, to: block.to });
		}
	}
	return hits;
}

/**
 * Suit le mot tapé dans la barre de recherche d'Obsidian (Ctrl+F) d'un éditeur. Obsidian insère cette
 * barre dans .markdown-source-view, juste avant view.dom, quand on l'ouvre, et l'en retire quand on la
 * ferme. Il la préremplit à l'ouverture avec la sélection et la vide à la fermeture, sans événement
 * « input » : l'insertion et le retrait de la barre sont donc guettés aussi.
 */
export class SearchWatcher {
	/** Mot cherché, "" quand la barre est fermée. */
	private query = "";
	private host: HTMLElement | null;
	private observer = new MutationObserver(() => this.refresh());
	/** Derniers blocs trouvés, avec le texte et le mot d'où ils viennent : un doc CM6 est immuable. */
	private cache: { doc: Text; query: string; hits: SearchHit[] } | null = null;

	constructor(view: EditorView, private onChange: () => void) {
		// Hors d'une note (canevas, fenêtre de survol…), pas de barre à suivre.
		this.host = view.dom.closest<HTMLElement>(".markdown-source-view");
		if (!this.host) return;
		this.host.addEventListener("input", this.onInput);
		this.observer.observe(this.host, { childList: true });
		this.query = this.read();
	}

	destroy() {
		this.host?.removeEventListener("input", this.onInput);
		this.observer.disconnect();
	}

	/** Blocs où apparaît le mot cherché, recalculés seulement quand le texte ou le mot a changé. */
	hits(state: EditorState): SearchHit[] {
		const { cache } = this;
		if (cache && cache.doc === state.doc && cache.query === this.query) return cache.hits;
		const hits = searchHits(state, this.query);
		this.cache = { doc: state.doc, query: this.query, hits };
		return hits;
	}

	private read(): string {
		const input = this.host?.querySelector<HTMLInputElement>(
			":scope > .document-search-container .document-search-input input"
		);
		return input?.value ?? "";
	}

	// La frappe dans la note arrive aussi jusqu'ici : seule compte celle dans la barre.
	private onInput = (event: Event) => {
		if ((event.target as HTMLElement | null)?.closest?.(".document-search-container")) this.refresh();
	};

	private refresh() {
		const query = this.read();
		if (query === this.query) return;
		this.query = query;
		this.onChange();
	}
}
