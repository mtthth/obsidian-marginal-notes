// Marginal Notes, par Matthieu Thomas (cidrolin). Licence MIT.

import { Menu } from "obsidian";
import { EditorView } from "@codemirror/view";
import { hasLabel, parseMarker } from "./model";
import { markerText, ParagraphBlock } from "./paragraphs";
import { applyTag } from "./tagEdit";
import { TextInputModal } from "./textInputModal";
import type MarginalNotesPlugin from "./main";

export function openTagMenu(
	plugin: MarginalNotesPlugin,
	view: EditorView,
	block: ParagraphBlock,
	event: MouseEvent
) {
	const existing = parseMarker(markerText(block))?.tag ?? {};
	const menu = new Menu();

	for (const p of plugin.settings.palette) {
		menu.addItem((item) => {
			const isActive = existing.color === p.key;
			const frag = document.createDocumentFragment();
			const dot = frag.createSpan({ cls: "mn-menu-swatch" });
			dot.style.setProperty("--mn-color", p.color);
			frag.createSpan({ text: isActive ? `${p.label} ✓` : p.label });
			item.setTitle(frag);
			item.onClick(() => {
				applyTag(view, block, { ...existing, color: isActive ? undefined : p.key });
			});
		});
	}

	menu.addSeparator();
	menu.addItem((item) => {
		item.setTitle(existing.text ? `Texte : "${existing.text}"…` : "Ajouter un texte…");
		item.setIcon("text-cursor-input");
		item.onClick(() => {
			new TextInputModal(plugin.app, existing.text ?? "", (value) => {
				applyTag(view, block, { ...existing, text: value || undefined });
			}).open();
		});
	});

	if (hasLabel(existing)) {
		menu.addSeparator();
		menu.addItem((item) => {
			item.setTitle("Supprimer l'étiquette");
			item.setIcon("trash-2");
			item.onClick(() => {
				// L'étiquette seulement : un paragraphe corné le reste.
				applyTag(view, block, { corner: existing.corner });
			});
		});
	}

	menu.showAtMouseEvent(event);
}
