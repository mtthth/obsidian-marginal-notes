import { Menu } from "obsidian";
import { EditorView } from "@codemirror/view";
import { encodeMarker, parseMarker, refreshMarkersEffect, ParagraphTag } from "./model";
import { markerText, ParagraphBlock } from "./paragraphs";
import { TextInputModal } from "./textInputModal";
import type MarginalNotesPlugin from "./main";

function applyTag(view: EditorView, block: ParagraphBlock, newTag: ParagraphTag) {
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
				applyTag(view, block, { color: isActive ? undefined : p.key, text: existing.text });
			});
		});
	}

	menu.addSeparator();
	menu.addItem((item) => {
		item.setTitle(existing.text ? `Texte : "${existing.text}"…` : "Ajouter un texte…");
		item.setIcon("text-cursor-input");
		item.onClick(() => {
			new TextInputModal(plugin.app, existing.text ?? "", (value) => {
				applyTag(view, block, { color: existing.color, text: value || undefined });
			}).open();
		});
	});

	if (existing.color || existing.text) {
		menu.addSeparator();
		menu.addItem((item) => {
			item.setTitle("Supprimer l'étiquette");
			item.setIcon("trash-2");
			item.onClick(() => {
				applyTag(view, block, {});
			});
		});
	}

	menu.showAtMouseEvent(event);
}
