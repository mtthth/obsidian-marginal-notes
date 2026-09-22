// Marginal Notes, par Matthieu Thomas (cidrolin). Licence MIT.

import { EditorState, Line, RangeSetBuilder, StateEffect, Text } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { SearchCursor } from "@codemirror/search";
import { allParagraphs, lineTextStart } from "./paragraphs";

/** Portion de la note où apparaît le mot cherché : un paragraphe entier, ou une ligne hors paragraphe. */
export interface SearchHit {
	from: number;
	to: number;
}

/**
 * Appelle `visit` pour chaque occurrence de `query` entre `from` et `to`, trouvée comme la trouve la
 * barre de recherche d'Obsidian : le même curseur CM6, sans égard à la casse. Seule exception, une
 * occurrence tout entière avant le texte de sa ligne, dans son préfixe markdown ou dans le marqueur
 * %%mn …%% masqué, ne compte pas : les clés de couleur (« vert », « rouge »…) ne doivent ni mettre en
 * valeur tous les paragraphes étiquetés dans la minipage, ni s'encadrer dans le texte.
 */
function forEachMatch(doc: Text, query: string, from: number, to: number, visit: (from: number, to: number) => void) {
	const cursor = new SearchCursor(doc, query, from, to, (s) => s.toLowerCase());
	let line: Line | null = null;
	let textFrom = 0;
	while (!cursor.next().done) {
		const match = cursor.value;
		if (!line || match.from > line.to) {
			line = doc.lineAt(match.from);
			textFrom = lineTextStart(line);
		}
		if (match.to > textFrom) visit(match.from, match.to);
	}
}

/**
 * Blocs de la note où apparaît `query`, dans l'ordre et chacun une seule fois : le paragraphe qui
 * contient l'occurrence, ou sa seule ligne quand elle est hors de tout paragraphe (frontmatter, bloc
 * de code, tableau…).
 */
export function searchHits(state: EditorState, query: string): SearchHit[] {
	const hits: SearchHit[] = [];
	if (!query) return hits;
	const doc = state.doc;
	const blocks = allParagraphs(state);
	let b = 0;
	forEachMatch(doc, query, 0, doc.length, (from) => {
		const last = hits[hits.length - 1];
		// Encore dans le bloc déjà retenu.
		if (last && from <= last.to) return;
		while (b < blocks.length && blocks[b].to < from) b++;
		const block = b < blocks.length && blocks[b].from <= from ? blocks[b] : doc.lineAt(from);
		hits.push({ from: block.from, to: block.to });
	});
	return hits;
}

/**
 * Suit le mot tapé dans la barre de recherche d'Obsidian (Ctrl+F) d'un éditeur. Obsidian insère cette
 * barre dans .markdown-source-view, juste avant view.dom, quand on l'ouvre, et l'en retire quand on la
 * ferme. Il la préremplit à l'ouverture avec la sélection et la vide à la fermeture, sans événement
 * « input » : l'insertion et le retrait de la barre sont donc guettés aussi.
 */
export class SearchWatcher {
	private current = "";
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
		this.current = this.read();
	}

	/** Mot cherché, "" quand la barre est fermée. */
	get query(): string {
		return this.current;
	}

	destroy() {
		this.host?.removeEventListener("input", this.onInput);
		this.observer.disconnect();
	}

	/** Blocs où apparaît le mot cherché, recalculés seulement quand le texte ou le mot a changé. */
	hits(state: EditorState): SearchHit[] {
		const { cache } = this;
		if (cache && cache.doc === state.doc && cache.query === this.current) return cache.hits;
		const hits = searchHits(state, this.current);
		this.cache = { doc: state.doc, query: this.current, hits };
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
		if (query === this.current) return;
		this.current = query;
		this.onChange();
	}
}

/** Le mot cherché a changé. La note, elle, n'a pas bougé : cet effet ne sert qu'à faire redessiner le texte. */
const searchChanged = StateEffect.define<void>();
const matchMark = Decoration.mark({ class: "mn-search-match" });

/**
 * Encadre dans le texte chaque occurrence du mot tapé dans la barre de recherche d'Obsidian, qui n'en
 * cerne elle-même qu'une, la courante. Seulement dans la partie affichée de la note, refaite au fil du
 * défilement : une longue note n'est pas parcourue en entier à chaque frappe.
 */
class SearchHighlighter {
	decorations: DecorationSet;
	private watcher: SearchWatcher;

	constructor(private view: EditorView) {
		this.watcher = new SearchWatcher(view, () => view.dispatch({ effects: searchChanged.of() }));
		this.decorations = this.build();
	}

	update(update: ViewUpdate) {
		if (
			update.docChanged ||
			update.viewportChanged ||
			update.transactions.some((tr) => tr.effects.some((e) => e.is(searchChanged)))
		) {
			this.decorations = this.build();
		}
	}

	destroy() {
		this.watcher.destroy();
	}

	private build(): DecorationSet {
		const { query } = this.watcher;
		if (!query) return Decoration.none;
		const builder = new RangeSetBuilder<Decoration>();
		for (const { from, to } of this.view.visibleRanges) {
			forEachMatch(this.view.state.doc, query, from, to, (start, end) => builder.add(start, end, matchMark));
		}
		return builder.finish();
	}
}

/** Extension : chaque occurrence du mot cherché (Ctrl+F), encadrée dans le texte. */
export const searchHighlighter = ViewPlugin.fromClass(SearchHighlighter, {
	decorations: (plugin) => plugin.decorations,
});
