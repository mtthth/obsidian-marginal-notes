import { App, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_PALETTE, PaletteColor } from "./model";
import type MarginalNotesPlugin from "./main";

export interface MarginalNotesSettings {
	palette: PaletteColor[];
	/** Transparence (en %) du fond coloré des paragraphes étiquetés : 100 = pas de fond. */
	backgroundTransparency: number;
	showMinimap: boolean;
}

export const DEFAULT_SETTINGS: MarginalNotesSettings = {
	palette: DEFAULT_PALETTE.map((p) => ({ ...p })),
	backgroundTransparency: 80,
	showMinimap: true,
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
		new Setting(containerEl)
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

		new Setting(containerEl).setName("Minipage").setHeading();
		new Setting(containerEl)
			.setName("Afficher la minipage")
			.setDesc("Vue d'ensemble de la note à droite de l'éditeur, avec les zones étiquetées en couleur. Cliquer dessus pour s'y rendre.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showMinimap).onChange(async (value) => {
					this.plugin.settings.showMinimap = value;
					await this.plugin.saveSettings();
					this.plugin.refreshAllEditors();
				})
			);
	}
}
