// Marginal Notes, par Matthieu Thomas (cidrolin). Licence MIT.

import { Editor, MarkdownView, Menu, Notice, Plugin } from "obsidian";
import { EditorView } from "@codemirror/view";
import { DEFAULT_SETTINGS, MarginalNotesSettings, MarginalNotesSettingTab } from "./settings";
import { createGutter, createTagField } from "./gutter";
import { createMinimap } from "./minimap";
import { flashField } from "./flash";
import { createCenterFlash } from "./centerFlash";
import { searchHighlighter } from "./search";
import { wordEcho } from "./wordEcho";
import { markerText, paragraphAt, type ParagraphBlock } from "./paragraphs";
import { openTagMenu } from "./menu";
import { centerOnClick, jumpToTag } from "./navigation";
import { createReadingPostProcessor } from "./reading";
import { parseMarker, refreshMarkersEffect } from "./model";
import { toggleCorner } from "./tagEdit";
import { readProblemZones } from "./problemZones";

// Obsidian n'expose pas officiellement la vue CodeMirror 6 sous-jacente sur Editor, mais
// `editor.cm` est l'accès de fait stable utilisé par l'écosystème des plugins pour l'obtenir.
function getCmView(editor: Editor): EditorView | undefined {
	return (editor as unknown as { cm?: EditorView }).cm;
}

function noParagraphNotice() {
	new Notice("Placez le curseur dans un paragraphe.");
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
			centerOnClick(this),
			createCenterFlash(),
			searchHighlighter,
			wordEcho,
		]);
		this.registerMarkdownPostProcessor(createReadingPostProcessor(this));
		this.addSettingTab(new MarginalNotesSettingTab(this.app, this));

		// En phase de capture, pour que la position soit à jour quand l'éditeur construit son menu.
		this.registerDomEvent(
			document,
			"contextmenu",
			(evt: MouseEvent) => {
				this.lastContextMenuPos = { x: evt.clientX, y: evt.clientY };
			},
			{ capture: true }
		);

		this.addCommand({
			id: "tag-current-paragraph",
			name: "Étiqueter le paragraphe courant",
			editorCallback: (editor: Editor) => {
				const cmView = getCmView(editor);
				if (!cmView) return;
				const head = cmView.state.selection.main.head;
				this.tagParagraph(cmView, paragraphAt(cmView.state, head), head);
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
				const cmView = getCmView(editor);
				if (!cmView) return;
				const pos =
					(this.lastContextMenuPos && cmView.posAtCoords(this.lastContextMenuPos)) ??
					cmView.state.selection.main.head;
				// Le paragraphe visé, relevé à l'ouverture du menu : le texte peut changer avant qu'on y
				// choisisse, et l'écriture le retrouvera alors (voir tagEdit.ts).
				const block = paragraphAt(cmView.state, pos);
				menu.addItem((item) => {
					item
						.setTitle("Étiqueter le paragraphe courant")
						.setIcon("tag")
						.onClick(() => this.tagParagraph(cmView, block, pos));
				});
				// Le titre dit ce que fera le clic : le paragraphe visé est-il déjà corné ?
				// Corner, c'est poser le même repère que le clic droit dans la minipage.
				const cornered = block ? parseMarker(markerText(block))?.tag.corner : false;
				menu.addItem((item) => {
					item
						.setTitle(cornered ? "Retirer la corne" : "Corner la page")
						.setIcon("sticky-note")
						.onClick(() => (block ? toggleCorner(cmView, block) : noParagraphNotice()));
				});
			})
		);
	}

	/** Ouvre le menu d'étiquetage du paragraphe, sous la position `pos` ; prévient s'il n'y a pas de paragraphe. */
	private tagParagraph(cmView: EditorView, block: ParagraphBlock | null, pos: number) {
		if (!block) return noParagraphNotice();

		// La position a pu être relevée sur un texte plus long qu'il ne l'est devenu.
		const coords = cmView.coordsAtPos(Math.min(pos, cmView.state.doc.length));
		const rect = cmView.dom.getBoundingClientRect();
		const fakeEvent = {
			clientX: coords ? coords.left : rect.left + 40,
			clientY: coords ? coords.bottom : rect.top + 40,
		} as MouseEvent;

		openTagMenu(this, cmView, block, fakeEvent);
	}

	/**
	 * Les notes ouvertes et chargées. Un onglet pas encore affiché depuis le démarrage est « différé » : sa
	 * vue n'est pas une MarkdownView et n'a ni éditeur ni rendu ; elle prendra les réglages à son chargement.
	 */
	private markdownViews(): MarkdownView[] {
		return this.app.workspace
			.getLeavesOfType("markdown")
			.map((leaf) => leaf.view)
			.filter((view): view is MarkdownView => view instanceof MarkdownView);
	}

	/** Fait redessiner la gouttière et la minipage de chaque note ouverte, sans toucher au mode lecture. */
	refreshEditorViews() {
		for (const view of this.markdownViews()) {
			getCmView(view.editor)?.dispatch({ effects: refreshMarkersEffect.of() });
		}
	}

	refreshAllEditors() {
		this.refreshEditorViews();
		for (const view of this.markdownViews()) view.previewMode?.rerender(true);
	}

	/** Couleur hexadécimale associée à une clé de la palette, si elle existe encore. */
	paletteColor(key: string | undefined): string | undefined {
		return key ? this.settings.palette.find((p) => p.key === key)?.color : undefined;
	}

	/** Libellé, dans la palette, d'une clé de couleur : ce que dit la couleur d'un paragraphe sans texte à lui. Absent s'il est vide. */
	paletteLabel(key: string | undefined): string | undefined {
		return (key && this.settings.palette.find((p) => p.key === key)?.label.trim()) || undefined;
	}

	/** Opacité (en %) du fond des paragraphes étiquetés, déduite de la transparence réglée. */
	backgroundAlpha(): number {
		return 100 - this.settings.backgroundTransparency;
	}

	async loadSettings() {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		// Une liste de zones que le fichier de données n'a pas, ou qu'on y a abîmée, repart de la liste par défaut ;
		// dans tous les cas une copie : celle de DEFAULT_SETTINGS ne doit pas bouger quand on règle les zones.
		this.settings.problemZones = readProblemZones(data?.problemZones);
		// Réglage retiré en 0.1.19 (les zones se colorent toutes dans la minipage) : qu'il ne reste pas dans data.json.
		Reflect.deleteProperty(this.settings, "problemMaxLength");
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
