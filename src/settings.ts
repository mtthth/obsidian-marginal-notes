import { App, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_PALETTE, PaletteColor } from "./model";
import { defaultProblemZones, ProblemZone } from "./problemZones";
import type MarginalNotesPlugin from "./main";

/**
 * Dessin de la minipage : « block », des blocs pleins que sépare la ligne vide de la note ; « paragraphs »,
 * sans ligne vide, chaque paragraphe se reconnaissant à sa forme.
 */
export type MinimapStyle = "block" | "paragraphs";

export interface MarginalNotesSettings {
	palette: PaletteColor[];
	/** Le fond des paragraphes étiquetés prend la couleur de leur étiquette (l'ovale de la gouttière, lui, reste). */
	paragraphBackground: boolean;
	/** Transparence (en %) du fond coloré des paragraphes étiquetés : 100 = pas de fond. */
	backgroundTransparency: number;
	showMinimap: boolean;
	minimapStyle: MinimapStyle;
	/** Minipage en « paragraphs » : la première ligne de chaque paragraphe est en retrait. */
	minimapIndent: boolean;
	/** Le premier clic dans un paragraphe le centre à l'écran et le fait clignoter. */
	centerOnClick: boolean;
	/** Les balisages qui signalent un endroit à reprendre, et la couleur dont la minipage les dessine. */
	problemZones: ProblemZone[];
}

export const DEFAULT_SETTINGS: MarginalNotesSettings = {
	palette: DEFAULT_PALETTE.map((p) => ({ ...p })),
	paragraphBackground: true,
	backgroundTransparency: 80,
	showMinimap: true,
	minimapStyle: "paragraphs",
	minimapIndent: true,
	centerOnClick: true,
	problemZones: defaultProblemZones(),
};

export class MarginalNotesSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: MarginalNotesPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Marginal Notes — palette de couleurs" });
		containerEl.createEl("p", {
			text: "Ces couleurs et libellés apparaissent dans le menu d'étiquetage des paragraphes. Renommer ou recolorer une entrée met à jour tous les paragraphes qui l'utilisent déjà.",
			cls: "setting-item-description",
		});

		this.plugin.settings.palette.forEach((entry, index) => {
			new Setting(containerEl)
				.setName(`Couleur ${index + 1}`)
				.addText((text) =>
					text
						.setPlaceholder("Libellé")
						.setValue(entry.label)
						.onChange(async (value) => {
							entry.label = value;
							await this.plugin.saveSettings();
						})
				)
				.addColorPicker((picker) =>
					picker.setValue(entry.color).onChange(async (value) => {
						entry.color = value;
						await this.plugin.saveSettings();
						this.plugin.refreshAllEditors();
					})
				)
				.addExtraButton((btn) =>
					btn
						.setIcon("trash-2")
						.setTooltip("Supprimer")
						.onClick(async () => {
							this.plugin.settings.palette.splice(index, 1);
							await this.plugin.saveSettings();
							this.plugin.refreshAllEditors();
							this.display();
						})
				);
		});

		new Setting(containerEl).addButton((btn) =>
			btn
				.setButtonText("Ajouter une couleur")
				.setCta()
				.onClick(async () => {
					const key = `c${Date.now()}`;
					this.plugin.settings.palette.push({ key, label: "Nouvelle étiquette", color: "#888888" });
					await this.plugin.saveSettings();
					this.display();
				})
		);

		new Setting(containerEl).setName("Fond des paragraphes").setHeading();
		// La transparence n'a de sens que si le fond est coloré : son réglage se masque sinon.
		let transparencySetting: Setting;
		new Setting(containerEl)
			.setName("Colorer le fond des paragraphes")
			.setDesc("Le fond d'un paragraphe étiqueté prend la couleur de son étiquette, dans l'éditeur et en mode lecture. Désactivé, la couleur ne se voit que dans l'ovale de la gouttière et dans la minipage.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.paragraphBackground).onChange(async (value) => {
					this.plugin.settings.paragraphBackground = value;
					await this.plugin.saveSettings();
					transparencySetting.settingEl.toggle(value);
					this.plugin.refreshAllEditors();
				})
			);
		transparencySetting = new Setting(containerEl)
			.setName("Transparence du fond")
			.setDesc("Transparence de la couleur d'étiquette appliquée au fond du paragraphe : 0 % = couleur pleine, 100 % = aucun fond.")
			.addSlider((slider) =>
				slider
					.setLimits(0, 100, 5)
					.setValue(this.plugin.settings.backgroundTransparency)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.backgroundTransparency = value;
						await this.plugin.saveSettings();
						this.plugin.refreshAllEditors();
					})
			);
		transparencySetting.settingEl.toggle(this.plugin.settings.paragraphBackground);

		new Setting(containerEl).setName("Clic dans le texte").setHeading();
		new Setting(containerEl)
			.setName("Centrer le paragraphe au clic")
			.setDesc("Le premier clic dans un paragraphe le centre à l'écran et le fait clignoter. Désactivé, un clic ne fait que poser le curseur, sans déplacer la vue.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.centerOnClick).onChange(async (value) => {
					this.plugin.settings.centerOnClick = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName("Minipage").setHeading();
		new Setting(containerEl)
			.setName("Afficher la minipage")
			.setDesc("Vue d'ensemble de la note à droite de l'éditeur. Comme dans la page, l'étiquette de chaque paragraphe y est dans la marge, et les zones à problème en couleur dans le texte. Cliquer dessus pour s'y rendre.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showMinimap).onChange(async (value) => {
					this.plugin.settings.showMinimap = value;
					await this.plugin.saveSettings();
					this.plugin.refreshAllEditors();
				})
			);

		// L'alinéa n'a de sens qu'en style « paragraphes » : son réglage se masque dans l'autre.
		let indentSetting: Setting;
		new Setting(containerEl)
			.setName("Style de la minipage")
			.setDesc(
				"Bloc plein : un aplat par bloc de texte, que sépare la ligne vide de la note. Paragraphes : les lignes vides disparaissent et la minipage grandit d'autant ; chaque paragraphe se reconnaît à sa dernière ligne, plus courte. Sur une note très longue, les lignes vides sont conservées."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("block", "Bloc plein")
					.addOption("paragraphs", "Paragraphes")
					.setValue(this.plugin.settings.minimapStyle)
					.onChange(async (value) => {
						this.plugin.settings.minimapStyle = value === "block" ? "block" : "paragraphs";
						await this.plugin.saveSettings();
						indentSetting.settingEl.toggle(this.plugin.settings.minimapStyle === "paragraphs");
						this.plugin.refreshAllEditors();
					})
			);
		indentSetting = new Setting(containerEl)
			.setName("Alinéa")
			.setDesc("La première ligne de chaque paragraphe est en retrait, comme dans un texte imprimé.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.minimapIndent).onChange(async (value) => {
					this.plugin.settings.minimapIndent = value;
					await this.plugin.saveSettings();
					this.plugin.refreshAllEditors();
				})
			);
		indentSetting.settingEl.toggle(this.plugin.settings.minimapStyle === "paragraphs");

		this.displayProblemZones(containerEl);
	}

	/** La liste des zones à problème : balisage d'ouverture et de fermeture, et couleur de chacune. */
	private displayProblemZones(containerEl: HTMLElement) {
		const { settings } = this.plugin;
		new Setting(containerEl).setName("Zones à problème").setHeading();
		containerEl.createEl("p", {
			text: "Le texte compris entre une ouverture et une fermeture, sur une seule ligne, prend dans la minipage la couleur de la zone, là où il se trouve dans sa ligne. Sans fermeture, c'est l'ouverture qui ferme. Le frontmatter, les blocs de code, de maths et de commentaires sont ignorés.",
			cls: "setting-item-description",
		});

		settings.problemZones.forEach((zone, index) => {
			new Setting(containerEl)
				.setName(`Zone ${index + 1}`)
				.addText((text) => {
					text.inputEl.size = 6;
					text
						.setPlaceholder("Ouverture")
						.setValue(zone.open)
						.onChange(async (value) => {
							zone.open = value;
							await this.plugin.saveSettings();
							this.plugin.refreshEditorViews();
						});
				})
				.addText((text) => {
					text.inputEl.size = 6;
					text
						.setPlaceholder("Fermeture")
						.setValue(zone.close)
						.onChange(async (value) => {
							zone.close = value;
							await this.plugin.saveSettings();
							this.plugin.refreshEditorViews();
						});
				})
				.addColorPicker((picker) =>
					picker.setValue(zone.color).onChange(async (value) => {
						zone.color = value;
						await this.plugin.saveSettings();
						this.plugin.refreshEditorViews();
					})
				)
				.addExtraButton((btn) =>
					btn
						.setIcon("trash-2")
						.setTooltip("Supprimer")
						.onClick(async () => {
							settings.problemZones.splice(index, 1);
							await this.plugin.saveSettings();
							this.plugin.refreshEditorViews();
							this.display();
						})
				);
		});

		new Setting(containerEl)
			.addButton((btn) =>
				btn
					.setButtonText("Ajouter une zone")
					.setCta()
					.onClick(async () => {
						settings.problemZones.push({ open: "", close: "", color: "#e600ac" });
						await this.plugin.saveSettings();
						this.display();
					})
			)
			.addButton((btn) =>
				btn.setButtonText("Rétablir la liste par défaut").onClick(async () => {
					settings.problemZones = defaultProblemZones();
					await this.plugin.saveSettings();
					this.plugin.refreshEditorViews();
					this.display();
				})
			);
	}
}
