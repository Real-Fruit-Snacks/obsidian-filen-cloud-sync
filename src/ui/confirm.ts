/**
 * Small two-button confirmation dialog (restore confirmation, memory-only
 * credential flows). Shared by settings.ts and the version-history UI.
 */

import { App, Modal, Setting } from "obsidian";

export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly title: string,
		private readonly message: string,
		private readonly confirmText: string,
		private readonly onConfirm: () => void,
		private readonly onCancel?: () => void,
		private readonly cancelText = "Cancel",
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.title);
		this.contentEl.createEl("p").setText(this.message);
		new Setting(this.contentEl)
			.addButton(button => button
				.setButtonText(this.cancelText)
				.onClick(() => {
					this.close();
					this.onCancel?.();
				}))
			.addButton(button => button
				.setButtonText(this.confirmText)
				.setCta()
				.onClick(() => {
					this.close();
					this.onConfirm();
				}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
