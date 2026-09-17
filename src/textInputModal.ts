import { App, Modal, Setting } from "obsidian";

export class TextInputModal extends Modal {
	private value: string;

	constructor(app: App, initialValue: string, private onSubmit: (value: string) => void) {
		super(app);
		this.value = initialValue;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Texte de l'étiquette" });

		let inputEl: HTMLInputElement | undefined;

		new Setting(contentEl).setName("Texte court").addText((text) => {
			inputEl = text.inputEl;
			text.setValue(this.value);
			text.onChange((v) => (this.value = v));
			text.inputEl.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") {
					evt.preventDefault();
					this.submit();
				}
			});
		});

		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText("Valider").setCta().onClick(() => this.submit()))
			.addButton((btn) => btn.setButtonText("Annuler").onClick(() => this.close()));

		window.setTimeout(() => inputEl?.focus(), 0);
	}

	private submit() {
		this.onSubmit(this.value);
		this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}
