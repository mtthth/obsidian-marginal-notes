// Marginal Notes, par Matthieu Thomas (cidrolin). Licence MIT.

import { Menu } from "obsidian";
import { EditorView } from "@codemirror/view";
import { hasLabel, parseMarker } from "./model";
import { markerText, ParagraphBlock } from "./paragraphs";
import { applyTag } from "./tagEdit";
import { TextInputModal } from "./textInputModal";
import type MarginalNotesPlugin from "./main";

/**
 * Ouvre le menu d'étiquetage du paragraphe à la position `at` (coordonnées de la fenêtre), dans la fenêtre de
 * l'éditeur : une fenêtre détachée a son propre document.
 */
export function openTagMenu(
	plugin: MarginalNotesPlugin,
	view: EditorView,
	block: ParagraphBlock,
	at: { x: number; y: number }
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

	menu.showAtPosition(at, view.dom.ownerDocument);
}
