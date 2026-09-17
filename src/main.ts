import { Editor, MarkdownView, Menu, Notice, Plugin } from "obsidian";
import { EditorView } from "@codemirror/view";
import { DEFAULT_SETTINGS, MarginalNotesSettings, MarginalNotesSettingTab } from "./settings";
import { createGutter, createTagField } from "./gutter";
import { createMinimap } from "./minimap";
import { flashField } from "./flash";
import { createCenterFlash } from "./centerFlash";
import { paragraphAt } from "./paragraphs";
import { openTagMenu } from "./menu";
import { centerOnClick, jumpToTag } from "./navigation";
import { createReadingPostProcessor } from "./reading";
import { refreshMarkersEffect } from "./model";

// Obsidian n'expose pas officiellement la vue CodeMirror 6 sous-jacente sur Editor, mais
// `editor.cm` est l'accès de fait stable utilisé par l'écosystème des plugins pour l'obtenir.
function getCmView(editor: Editor): EditorView | undefined {
	return (editor as unknown as { cm?: EditorView }).cm;
}

export default class MarginalNotesPlugin extends Plugin {
	settings!: MarginalNotesSettings;
	// Le clic droit ne déplace pas le curseur CM6 : on retient la position de l'événement
	// natif "contextmenu" pour retrouver le paragraphe visé au clic, plutôt que de se fier
	// à selection.main.head qui reflète l'ancienne position du curseur.
	private lastContextMenuPos: { x: number; y: number } | null = null;

	async onload() {
		await this.loadSettings();

		const tagField = createTagField(this);
		this.registerEditorExtension([
			tagField,
			flashField,
			createGutter(this, tagField),
			createMinimap(this, tagField),
			centerOnClick(),
			createCenterFlash(),
		]);
		this.registerMarkdownPostProcessor(createReadingPostProcessor(this));
		this.addSettingTab(new MarginalNotesSettingTab(this.app, this));

		this.registerDomEvent(document, "contextmenu", (evt: MouseEvent) => {
			this.lastContextMenuPos = { x: evt.clientX, y: evt.clientY };
		});

		this.addCommand({
			id: "tag-current-paragraph",
			name: "Étiqueter le paragraphe courant",
			editorCallback: (editor: Editor) => {
				const cmView = getCmView(editor);
				if (cmView) this.tagParagraphAt(cmView, cmView.state.selection.main.head);
			},
		});

		this.addCommand({
			id: "next-tag",
			name: "Aller à l'étiquette suivante",
			editorCallback: (editor: Editor) => {
				const cmView = getCmView(editor);
				if (cmView) jumpToTag(cmView, 1);
			},
		});

		this.addCommand({
			id: "previous-tag",
			name: "Aller à l'étiquette précédente",
			editorCallback: (editor: Editor) => {
				const cmView = getCmView(editor);
				if (cmView) jumpToTag(cmView, -1);
			},
		});

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
				menu.addItem((item) => {
					item
						.setTitle("Étiqueter le paragraphe courant")
						.setIcon("tag")
						.onClick(() => {
							const cmView = getCmView(editor);
							if (!cmView) return;
							const pos = this.lastContextMenuPos && cmView.posAtCoords(this.lastContextMenuPos);
							this.tagParagraphAt(cmView, pos ?? cmView.state.selection.main.head);
						});
				});
			})
		);
	}

	private tagParagraphAt(cmView: EditorView, pos: number) {
		const block = paragraphAt(cmView.state, pos);
		if (!block) {
			new Notice("Placez le curseur dans un paragraphe.");
			return;
		}

		const coords = cmView.coordsAtPos(pos);
		const rect = cmView.dom.getBoundingClientRect();
		const fakeEvent = {
			clientX: coords ? coords.left : rect.left + 40,
			clientY: coords ? coords.bottom : rect.top + 40,
		} as MouseEvent;

		openTagMenu(this, cmView, block, fakeEvent);
	}

	refreshAllEditors() {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view as MarkdownView;
			const cmView = getCmView(view.editor);
			cmView?.dispatch({ effects: refreshMarkersEffect.of() });
			view.previewMode?.rerender(true);
		}
	}

	/** Couleur hexadécimale associée à une clé de la palette, si elle existe encore. */
	paletteColor(key: string | undefined): string | undefined {
		return key ? this.settings.palette.find((p) => p.key === key)?.color : undefined;
	}

	/** Opacité (en %) du fond des paragraphes étiquetés, déduite de la transparence réglée. */
	backgroundAlpha(): number {
		return 100 - this.settings.backgroundTransparency;
	}

	async loadSettings() {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
