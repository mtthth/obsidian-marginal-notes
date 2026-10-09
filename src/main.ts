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
	// natif "contextmenu", et l'élément visé, pour retrouver le paragraphe visé au clic, plutôt
	// que de se fier à selection.main.head qui reflète l'ancienne position du curseur.
	private lastContextMenu: { x: number; y: number; target: Node | null } | null = null;
	/** Documents où l'on guette le clic droit : celui de la fenêtre principale et de chaque fenêtre détachée. */
	private contextMenuDocs = new Set<Document>();

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

		// Une fenêtre détachée a son propre document : le clic droit se guette dans chacune, celles déjà
		// ouvertes quand le plugin se charge comme celles qu'on ouvrira.
		this.watchContextMenus(document);
		this.app.workspace.onLayoutReady(() =>
			this.app.workspace.iterateAllLeaves((leaf) => this.watchContextMenus(leaf.view.containerEl.ownerDocument))
		);
		this.registerEvent(this.app.workspace.on("window-open", (win) => this.watchContextMenus(win.doc)));
		this.registerEvent(this.app.workspace.on("window-close", (win) => this.unwatchContextMenus(win.doc)));

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
				// Le clic droit ne vaut que s'il a eu lieu dans le texte de cet éditeur, et pour ce menu-ci : fait
				// dans une autre fenêtre ou une autre note, ou menu ouvert au clavier, c'est le curseur qui vise.
				const last = this.lastContextMenu;
				this.lastContextMenu = null;
				const clicked = last?.target && cmView.contentDOM.contains(last.target) ? cmView.posAtCoords(last) : null;
				const pos = clicked ?? cmView.state.selection.main.head;
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

	onunload() {
		for (const doc of [...this.contextMenuDocs]) this.unwatchContextMenus(doc);
	}

	// En phase de capture, pour que la position soit à jour quand l'éditeur construit son menu.
	private watchContextMenus(doc: Document) {
		if (this.contextMenuDocs.has(doc)) return;
		this.contextMenuDocs.add(doc);
		doc.addEventListener("contextmenu", this.onContextMenu, { capture: true });
	}

	/** Cesse de guetter une fenêtre qui se ferme, et lâche ce qu'on y avait retenu. */
	private unwatchContextMenus(doc: Document) {
		this.contextMenuDocs.delete(doc);
		doc.removeEventListener("contextmenu", this.onContextMenu, { capture: true });
		if (this.lastContextMenu?.target?.ownerDocument === doc) this.lastContextMenu = null;
	}

	// Pas de `instanceof Node` : un élément d'une fenêtre détachée n'est pas une instance du Node de la principale.
	private onContextMenu = (evt: MouseEvent) => {
		this.lastContextMenu = { x: evt.clientX, y: evt.clientY, target: evt.target as Node | null };
	};

	/** Ouvre le menu d'étiquetage du paragraphe, sous la position `pos` ; prévient s'il n'y a pas de paragraphe. */
	private tagParagraph(cmView: EditorView, block: ParagraphBlock | null, pos: number) {
		if (!block) return noParagraphNotice();

		// Sous la position, ou au coin de l'éditeur si elle n'est pas affichée. Elle a pu être relevée sur un
		// texte plus long qu'il ne l'est devenu.
		const coords = cmView.coordsAtPos(Math.min(pos, cmView.state.doc.length));
		const rect = cmView.dom.getBoundingClientRect();
		openTagMenu(this, cmView, block, {
			x: coords ? coords.left : rect.left + 40,
			y: coords ? coords.bottom : rect.top + 40,
		});
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
