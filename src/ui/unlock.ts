/**
 * Unlock modal (feature C): memory-only credential mode starts LOCKED on
 * every Obsidian launch — keys are never on disk, so the user unlocks with
 * their account password (+ optional 2FA) once per session.
 */

import { App, Modal, Setting } from "obsidian";

export class UnlockModal extends Modal {
	private passwordValue = "";
	private twoFactorValue = "";
	private errorEl: HTMLElement | null = null;
	private busy = false;

	constructor(
		app: App,
		private readonly email: string,
		private readonly onUnlock: (password: string, twoFactorCode?: string) => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Unlock Filen Cloud Sync");
		this.contentEl.createEl("p").setText(
			`Memory-only mode is on — keys are never stored on disk. `
			+ `Enter the password for ${this.email} to unlock syncing for this session.`,
		);
		new Setting(this.contentEl)
			.setName("Password")
			.addText(text => {
				text.inputEl.type = "password";
				text.setPlaceholder("Password")
					.onChange(value => {
						this.passwordValue = value;
					});
				text.inputEl.addEventListener("keydown", event => {
					if (event.key === "Enter") void this.submit();
				});
			});
		new Setting(this.contentEl)
			.setName("Two-factor code")
			.setDesc("6-digit TOTP, only if 2FA is enabled on your account")
			.addText(text => text
				.setPlaceholder("XXXXXX")
				.onChange(value => {
					this.twoFactorValue = value.trim();
				}));
		this.errorEl = this.contentEl.createDiv({ cls: "filen-cloud-sync-unlock-error" });
		new Setting(this.contentEl)
			.addButton(button => button
				.setButtonText("Unlock")
				.setCta()
				.onClick(() => void this.submit()));
	}

	private async submit(): Promise<void> {
		if (this.busy) return;
		if (this.passwordValue.length === 0) {
			this.errorEl?.setText("Enter your password first.");
			return;
		}
		this.busy = true;
		this.errorEl?.setText("Unlocking…");
		try {
			await this.onUnlock(
				this.passwordValue,
				this.twoFactorValue.length > 0 ? this.twoFactorValue : undefined,
			);
			this.close();
		} catch (e) {
			this.errorEl?.setText(e instanceof Error ? e.message : String(e));
		} finally {
			this.busy = false;
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
