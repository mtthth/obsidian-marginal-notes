// Marginal Notes, par Matthieu Thomas (cidrolin). Licence MIT.

import { EditorState } from "@codemirror/state";
import type { MarkdownPostProcessorContext } from "obsidian";
import { hasLabel } from "./model";
import { TaggedParagraph, taggedParagraphs } from "./paragraphs";
import type MarginalNotesPlugin from "./main";

// En mode lecture il n'y a pas d'éditeur CM6, donc pas de gouttière, et Obsidian retire les
// commentaires %%…%% du rendu : on relit la source de chaque section pour y retrouver le
// marqueur, puis l'ovale est dessiné en CSS dans la marge du bloc rendu.

let cachedText: string | null = null;
let cachedTagged: TaggedParagraph[] = [];

// Obsidian appelle le post-processeur une fois par section, avec chaque fois le texte complet
// de la note : on ne redécoupe le document que lorsque ce texte change.
function taggedParagraphsOf(text: string): TaggedParagraph[] {
	if (text !== cachedText) {
		cachedText = text;
		cachedTagged = taggedParagraphs(EditorState.create({ doc: text }));
	}
	return cachedTagged;
}

export function createReadingPostProcessor(plugin: MarginalNotesPlugin) {
	return (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
		const info = ctx.getSectionInfo(el);
		if (!info) return;

		// Les numéros de ligne de CM6 commencent à 1, ceux des sections à 0.
		const hit = taggedParagraphsOf(info.text).find((t) => {
			const lineIndex = t.block.firstLine.number - 1;
			return hasLabel(t.tag) && lineIndex >= info.lineStart && lineIndex <= info.lineEnd;
		});
		if (!hit) return;

		const target = el.firstElementChild instanceof HTMLElement ? el.firstElementChild : el;
		target.addClass("mn-reading-tag");
		const color = plugin.paletteColor(hit.tag.color);
		if (color) {
			// La couleur sert aussi à l'ovale de la marge ; seul le fond est facultatif.
			target.style.setProperty("--mn-color", color);
			if (plugin.settings.paragraphBackground) {
				target.addClass("mn-has-color");
				target.style.setProperty("--mn-bg-alpha", `${plugin.backgroundAlpha()}%`);
			}
		}
		if (hit.tag.text) target.setAttribute("data-mn-label", hit.tag.text);
	};
}
