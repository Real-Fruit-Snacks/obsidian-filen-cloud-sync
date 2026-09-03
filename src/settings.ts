/**
 * Settings schema (data.json — NO secrets, NO per-device state) + settings
 * tab with the connect/disconnect flow (the design docs).
 */

import { AbstractInputSuggest, App, Notice, PluginSettingTab, Setting, TextAreaComponent, TextComponent, TFolder } from "obsidian";
import { setDebugLogging } from "./debug";
import { FilenApiError, FilenClient } from "./filen/client";
import type { HttpFn } from "./filen/types";
import { obsidianHttp } from "./http";
import { ConflictPolicy, SyncDirection } from "./sync/types";
import { applyPrefs } from "./sync/sharedPrefs";
import { buildSetupUri, parseSetupUri } from "./sync/setupTransfer";
import { clearCredentials, clearState, loadCredentials, loadDeviceId, saveCredentials } from "./sync/state";
import { ConfirmModal } from "./ui/confirm";
import {
	CONFIG_PRESETS,
	customAllowlistEntries,
	isPresetEnabled,
	mergeAllowlist,
	normalizeVaultPath,
	togglePreset,
} from "./util";
import type FilenSyncPlugin from "./main";

export interface FilenSyncSettings {
	email: string;
	remoteFolder: string; // "Obsidian/<vaultName>" — <vaultName> substituted
	autoSyncInterval: boolean;
	syncIntervalMinutes: number;
	autoSyncOnStart: boolean;
	syncOnSave: boolean;
	notifyOnBackgroundChanges: boolean; // v0.8.0: one notice after background runs that moved files (never shared)
	syncDirection: SyncDirection; // v0.7.0: two-way / push / pull (per-device, never shared)
	syncPaused: boolean; // v0.7.1: blocks every sync trigger path until resumed (never shared)
	conflictPolicy: ConflictPolicy;
	conflictResolution: "auto" | "ask"; // v0.4.0 E: interactive merge view for text conflicts
	fastRemotePolling: boolean; // v0.4.0 D: events probe + cached remote tree
	syncConfigDir: boolean; // v0.4.0 A: opt-in selective .obsidian config sync
	configSyncAllowlist: string[]; // paths relative to the config dir
	excludeDotFiles: boolean;
	ignorePatterns: string;
	ignoredFolders: string[]; // vault-relative, NFC, no slashes; "" never allowed
	skipLargeFiles: boolean;
	skipSizeLargerThanMB: number;
	massChangeGuard: boolean;
	massChangeAbortPercent: number;
	memoryOnlyCredentials: boolean; // never persist keys — unlock per session
	debugLog: boolean;
	shareSettings: boolean; // v0.5.0: opt-in sync of the shared prefs subset
	deviceName: string; // display name written into the shared prefs file
	sharedPrefsAppliedAt: number; // per-device bookkeeping — itself never shared
}

export function defaultSettings(vaultName: string): FilenSyncSettings {
	return {
		email: "",
		remoteFolder: `Obsidian/${vaultName}`,
		autoSyncInterval: true,
		syncIntervalMinutes: 10,
		autoSyncOnStart: true,
		syncOnSave: true,
		notifyOnBackgroundChanges: false,
		syncDirection: "twoWay",
		syncPaused: false,
		conflictPolicy: "keep_both",
		conflictResolution: "auto",
		fastRemotePolling: true,
		syncConfigDir: false,
		configSyncAllowlist: [
			"appearance.json",
			"hotkeys.json",
			"community-plugins.json",
			"core-plugins.json",
			"snippets",
		],
		excludeDotFiles: true,
		ignorePatterns: "",
		ignoredFolders: [],
		skipLargeFiles: true,
		skipSizeLargerThanMB: 50,
		massChangeGuard: true,
		massChangeAbortPercent: 50,
		memoryOnlyCredentials: false,
		debugLog: false,
		shareSettings: false,
		deviceName: vaultName,
		sharedPrefsAppliedAt: 0,
	};
}

/** Normalize an ignored-folder candidate; "" when invalid. */
export function normalizeIgnoredFolder(input: string): string {
	return normalizeVaultPath(input);
}

/** Substitute <vaultName> and normalize the configured remote folder. */
export function resolveRemoteFolder(template: string, vaultName: string): string {
	const substituted = template.replace(/<vaultName>/gi, vaultName);
	return substituted.split("/").map(s => s.trim()).filter(s => s.length > 0).join("/");
}

export class FilenSyncSettingTab extends PluginSettingTab {
	private passwordValue = "";
	private twoFactorValue = "";
	/** Direction chosen in the connect form (v0.7.2) — applied on successful connect. */
	private connectDirection: SyncDirection = "twoWay";
	private folderInput: TextComponent | null = null;

	constructor(app: App, private readonly plugin: FilenSyncPlugin) {
		super(app, plugin);
		this.connectDirection = this.plugin.settings.syncDirection;
	}

	/**
	 * Imperative-tab refresh. This tab is fully custom (auth flow, suggesters,
	 * dynamic toggle groups) — the declarative settings API cannot express it,
	 * so display() remains the correct render path; update() only re-indexes
	 * declarative definitions, which we intentionally do not provide.
	 * All refreshes route through here (single display() call site).
	 */
	private refresh(): void {
		this.display();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("filen-cloud-sync-settings");

		const credentials = this.plugin.getMemoryCredentials() ?? loadCredentials(this.app);

		new Setting(containerEl).setName("Filen account").setHeading();

		if (credentials) {
			const connected = new Setting(containerEl)
				.setName("Connected")
				.setDesc(`Connected as ${credentials.email}`);
			connected.descEl.addClass("filen-cloud-sync-connected");
			connected.addButton(button => {
				button.setDestructive();
				button.setButtonText("Disconnect")
					.onClick(async () => {
					this.plugin.setMemoryCredentials(null);
					clearCredentials(this.app);
					clearState(this.app);
					this.plugin.settings.email = "";
					await this.plugin.saveSettings();
						new Notice("Filen disconnected (credentials and local sync state cleared)");
						this.refresh();
					});
			});
		} else {
			new Setting(containerEl)
				.setName("Email")
				.setDesc("Your Filen account email")
				.addText(text => text
					.setPlaceholder("you@example.com")
					.setValue(this.plugin.settings.email)
					.onChange(async value => {
						this.plugin.settings.email = value.trim();
						await this.plugin.saveSettings();
					}));
			new Setting(containerEl)
				.setName("Password")
				.setDesc("Used once to derive keys — never stored")
				.addText(text => {
					text.inputEl.type = "password";
					text.setPlaceholder("Password")
						.setValue(this.passwordValue)
						.onChange(value => {
							this.passwordValue = value;
						});
				});
			new Setting(containerEl)
				.setName("Two-factor code")
				.setDesc("6-digit TOTP, only if 2FA is enabled on your account")
				.addText(text => text
					.setPlaceholder("XXXXXX")
					.setValue(this.twoFactorValue)
					.onChange(value => {
						this.twoFactorValue = value.trim();
					}));
			new Setting(containerEl)
				.setName("This device will sync")
				.setDesc(
					"Choose before connecting — it decides what your first sync does. "
					+ "Pull never uploads (safe for receive-only devices); "
					+ "push never downloads and overwrites the cloud. Changeable later.",
				)
				.addDropdown(dropdown => dropdown
					.addOption("twoWay", "Both ways (sync everything)")
					.addOption("pull", "Download only (receive changes)")
					.addOption("push", "Upload only (mirror this vault to the cloud)")
					.setValue(this.connectDirection)
					.onChange(value => {
						this.connectDirection = value as SyncDirection;
					}));

			new Setting(containerEl)
				.setName("Connect")
				.setDesc("Verify credentials and resolve the remote sync folder")
				.addButton(button => button
					.setButtonText("Connect & verify")
					.setCta()
					.onClick(async () => {
						await this.connectFlow(button.buttonEl);
					}));
		}

		new Setting(containerEl)
			.setName("Memory-only credentials")
			.setDesc("Never store keys on disk — unlock with your password each time Obsidian starts.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.memoryOnlyCredentials)
				.onChange(async value => {
					if (value) {
						// Enabling: move any persisted credentials into memory, then
						// wipe them from per-device storage.
						const persisted = loadCredentials(this.app);
						if (persisted) {
							this.plugin.setMemoryCredentials(persisted);
							clearCredentials(this.app);
						}
						this.plugin.settings.memoryOnlyCredentials = true;
						await this.plugin.saveSettings();
						// No this.display() — nothing visible depends on this flag,
						// and a rebuild would reset the settings scroll position.
						return;
					}
					this.plugin.settings.memoryOnlyCredentials = false;
					await this.plugin.saveSettings();
					const inMemory = this.plugin.getMemoryCredentials();
					if (inMemory) {
						// Disabling with unlocked in-memory keys: offer to persist
						// them, otherwise they are lost on unload (that's the point).
						new ConfirmModal(
							this.app,
							"Store keys on this device?",
							"Memory-only mode is off. Keep the unlocked keys in per-device "
							+ "storage, or discard them and unlock again next time?",
							"Store keys",
							() => {
								saveCredentials(this.app, inMemory);
								new Notice("Filen keys stored on this device");
							},
							() => {
								this.plugin.setMemoryCredentials(null);
								new Notice("Filen keys discarded — unlock again to sync");
							},
							"Discard keys",
						).open();
					}
				}));

		new Setting(containerEl).setName("Sync").setHeading();

		// v0.7.1 feature B: the pause switch blocks EVERY trigger path (auto
		// interval, sync-on-save, startup, manual commands). Per-device, never
		// a shared-settings key.
		new Setting(containerEl)
			.setName("Pause syncing")
			.setDesc("Stop all syncing (automatic and manual) until resumed.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncPaused)
				.onChange(async value => {
					await this.plugin.setSyncPaused(value);
				}));

		const remoteFolderSetting = new Setting(containerEl)
			.setName("Remote folder")
			.setDesc(
				credentials
					? "Locked while connected — changing the remote folder takes effect only after Disconnect + reconnect."
					: "Folder in your Filen drive to sync into. <vaultName> is replaced with this vault's name.",
			)
			.addText(text => {
				text.setPlaceholder("Obsidian/<vaultName>")
					.setValue(this.plugin.settings.remoteFolder)
					.onChange(async value => {
						this.plugin.settings.remoteFolder = value.trim().length > 0
							? value.trim()
							: `Obsidian/${this.app.vault.getName()}`;
						await this.plugin.saveSettings();
					});
				if (credentials) text.setDisabled(true);
			});
		if (credentials) remoteFolderSetting.descEl.addClass("filen-cloud-sync-warning");

		// Toggle updates the paired input directly — calling this.display()
		// here would re-render the whole tab and reset scroll to top.
		let intervalText: TextComponent | null = null;
		new Setting(containerEl)
			.setName("Automatic interval sync")
			.setDesc("Sync every N minutes while Obsidian runs")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSyncInterval)
				.onChange(async value => {
					this.plugin.settings.autoSyncInterval = value;
					await this.plugin.saveSettings();
					this.plugin.rescheduleAutoSync();
					intervalText?.setDisabled(!value);
				}))
			.addText(text => {
				intervalText = text;
				text.setPlaceholder("10")
					.setValue(String(this.plugin.settings.syncIntervalMinutes))
					.onChange(async value => {
						const minutes = Number(value);
						if (Number.isFinite(minutes) && minutes >= 1) {
							this.plugin.settings.syncIntervalMinutes = Math.floor(minutes);
							await this.plugin.saveSettings();
							this.plugin.rescheduleAutoSync();
						}
					});
				text.setDisabled(!this.plugin.settings.autoSyncInterval);
			});

		new Setting(containerEl)
			.setName("Sync on start")
			.setDesc("Run a sync when Obsidian finishes loading")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSyncOnStart)
				.onChange(async value => {
					this.plugin.settings.autoSyncOnStart = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Sync on save")
			.setDesc("Run a sync shortly after files change in the vault")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncOnSave)
				.onChange(async value => {
					this.plugin.settings.syncOnSave = value;
					await this.plugin.saveSettings();
				}));

		// v0.8.0 feature 2: opt-in — background runs are otherwise silent on
		// success. One aggregate notice per run, never per file.
		new Setting(containerEl)
			.setName("Notify when a background sync changes files")
			.setDesc("Show a one-line notice when a background sync (interval, on-save, startup) uploads, downloads or deletes files.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.notifyOnBackgroundChanges)
				.onChange(async value => {
					this.plugin.settings.notifyOnBackgroundChanges = value;
					await this.plugin.saveSettings();
				}));

		// v0.7.0: per-device sync direction (NOT a shared-settings key —
		// which device pushes/pulls is inherently a per-device choice).
		new Setting(containerEl)
			.setName("Sync direction")
			.setDesc(
				"Push and pull are MIRRORS: the source side wins everywhere — foreign "
				+ "edits on the other side are reverted, and deletions propagate from "
				+ "the source.",
			)
			.addDropdown(dropdown => dropdown
				.addOption("twoWay", "Two-way (sync both ways)")
				.addOption("push", "Push (this device overwrites the cloud)")
				.addOption("pull", "Pull (the cloud overwrites this device)")
				.setValue(this.plugin.settings.syncDirection)
				.onChange(async value => {
					this.plugin.settings.syncDirection = value as SyncDirection;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Conflict policy")
			.setDesc("What to do when both sides changed the same file")
			.addDropdown(dropdown => dropdown
				.addOption("keep_both", "Keep both (rename loser)")
				.addOption("keep_newer", "Keep newer (trash loser)")
				.setValue(this.plugin.settings.conflictPolicy)
				.onChange(async value => {
					this.plugin.settings.conflictPolicy = value as ConflictPolicy;
					await this.plugin.saveSettings();
					this.plugin.onSharedSettingChanged(); // shared key (v0.5.0)
				}));

		new Setting(containerEl)
			.setName("Conflict resolution")
			.setDesc(
				"Auto applies the conflict policy above silently. Ask pauses on each text "
				+ "conflict and opens a side-by-side merge view (binary or very large files "
				+ "always fall back to auto).",
			)
			.addDropdown(dropdown => dropdown
				.addOption("auto", "Auto (apply conflict policy)")
				.addOption("ask", "Ask (show merge view)")
				.setValue(this.plugin.settings.conflictResolution)
				.onChange(async value => {
					this.plugin.settings.conflictResolution = value as "auto" | "ask";
					await this.plugin.saveSettings();
					this.plugin.onSharedSettingChanged(); // shared key (v0.5.0)
				}));

		new Setting(containerEl)
			.setName("Fast remote polling")
			.setDesc(
				"Probe Filen's events feed and skip the full remote scan when nothing "
				+ "changed. A cached remote tree is reused for at most 30 minutes, then "
				+ "always refreshed; while a cached tree is in use, remote-folder cleanup "
				+ "(pruning) is skipped entirely, and any probe failure falls back to a "
				+ "full scan. Manual \"Sync now\" runs always scan in full.",
			)
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.fastRemotePolling)
				.onChange(async value => {
					this.plugin.settings.fastRemotePolling = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Sync Obsidian config folder")
			.setDesc(
				"Sync the allowlisted files inside your vault's config folder (appearance, "
				+ "hotkeys, plugin lists, CSS snippets). workspace.json is never synced. "
				+ "Config syncs with keep-newest semantics. Don't edit the same setting on "
				+ "two devices at once. Config changes don't trigger live sync — they're "
				+ "picked up on the next interval, manual or startup sync.",
			)
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncConfigDir)
				.onChange(async value => {
					this.plugin.settings.syncConfigDir = value;
					await this.plugin.saveSettings();
					applyAllowlistState();
				}));

		// Always rendered (dimmed + disabled while off) — conditional rendering
		// forced a full display() rebuild on every toggle, resetting scroll.
		const allowlistSection = containerEl.createDiv();
		const allowlistInputs: Array<{ setDisabled(disabled: boolean): void }> = [];
		const applyAllowlistState = (): void => {
			const off = !this.plugin.settings.syncConfigDir;
			for (const input of allowlistInputs) input.setDisabled(off);
			allowlistSection.toggleClass("filen-cloud-sync-disabled", off);
		};

		// Friendly preset toggles for the well-known config items — they edit
		// the same configSyncAllowlist underneath (v0.5.1).
		for (const preset of CONFIG_PRESETS) {
			const row = new Setting(allowlistSection)
				.setName(preset.label)
				.setDesc(preset.desc)
				.addToggle(toggle => {
					allowlistInputs.push(toggle);
					toggle
						.setValue(isPresetEnabled(this.plugin.settings.configSyncAllowlist, preset.path))
						.onChange(async value => {
							this.plugin.settings.configSyncAllowlist = togglePreset(
								this.plugin.settings.configSyncAllowlist, preset.path, value,
							);
							await this.plugin.saveSettings();
							this.plugin.onSharedSettingChanged(); // shared key (v0.5.0)
						});
				});
			if (preset.warning) row.descEl.addClass("filen-cloud-sync-warning");
		}

		new Setting(allowlistSection)
			.setName("Custom config paths")
			.setDesc(
				"Additional files or folders inside the config folder to sync, one per line. "
				+ "Folders sync recursively. Everything not listed stays excluded; "
				+ "workspace.json is never synced, even if listed here.",
			)
			.addTextArea(text => {
				allowlistInputs.push(text);
				text.setPlaceholder("e.g. app.json\ngraph.json")
					.setValue(customAllowlistEntries(this.plugin.settings.configSyncAllowlist).join("\n"))
					.onChange(async value => {
						this.plugin.settings.configSyncAllowlist = mergeAllowlist(
							this.plugin.settings.configSyncAllowlist, value.split("\n"),
						);
						await this.plugin.saveSettings();
						this.plugin.onSharedSettingChanged(); // shared key (v0.5.0)
					});
				text.inputEl.rows = 4;
			});
		applyAllowlistState();

		// v0.5.0: opt-in shared settings (curated subset; last writer wins).
		new Setting(containerEl)
			.setName("Share settings across devices")
			.setDesc(
				"Syncs conflict policy, dotfile rule, ignore patterns, ignored folders and the "
				+ "config allowlist via an encrypted file in the remote folder. Last writer wins. "
				+ "Credentials, remote folder, sync direction, sync intervals, size limits and "
				+ "debug/device options always stay per-device.",
			)
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.shareSettings)
				.onChange(async value => {
					if (value) {
						this.plugin.settings.shareSettings = true;
						await this.plugin.saveSettings();
						// Fetches + applies the remote file, or seeds it with the
						// local prefs. On failure the toggle reverts to off.
						const ok = await this.plugin.enableSharedSettings();
						if (!ok) {
							this.plugin.settings.shareSettings = false;
							await this.plugin.saveSettings();
							toggle.setValue(false);
						}
						return;
					}
					this.plugin.settings.shareSettings = false;
					await this.plugin.saveSettings();
					this.plugin.disableSharedSettings();
				}));

		new Setting(containerEl)
			.setName("Device name")
			.setDesc("Shown in the sync log when this device writes shared settings")
			.addText(text => text
				.setPlaceholder(this.app.vault.getName())
				.setValue(this.plugin.settings.deviceName)
				.onChange(async value => {
					this.plugin.settings.deviceName = value.trim().length > 0
						? value.trim()
						: this.app.vault.getName();
					await this.plugin.saveSettings();
				}));

		// v0.6.0 feature B: copy settings (never credentials) between devices
		// via a setup URI. QR code transfer is intentionally out of scope.
		new Setting(containerEl).setName("Setup transfer").setHeading();

		new Setting(containerEl)
			.setName("Export setup")
			.setDesc(
				"Paste this on your other device to copy settings. Contains folder "
				+ "paths and your email — never passwords or keys.",
			)
			.addText(text => {
				// Regenerated on every display() — always reflects current settings.
				text.setValue(buildSetupUri(this.plugin.settings));
				text.inputEl.readOnly = true;
				text.inputEl.addClass("filen-cloud-sync-setup-uri");
			})
			.addButton(button => button
				.setButtonText("Copy")
				.onClick(() => {
					void navigator.clipboard.writeText(buildSetupUri(this.plugin.settings));
					new Notice("Setup link copied — paste it on your other device");
				}));

		let importArea: TextAreaComponent | null = null;
		new Setting(containerEl)
			.setName("Import setup")
			.setDesc(
				"Paste a setup link from another device. Importing never connects "
				+ "or stores credentials — you still enter your Filen password yourself.",
			)
			.addTextArea(text => {
				importArea = text;
				text.setPlaceholder("filen-cloud-sync://setup/…");
				text.inputEl.rows = 3;
			})
			.addButton(button => button
				.setButtonText("Apply imported setup")
				.onClick(async () => {
					const parsed = parseSetupUri(importArea?.getValue() ?? "");
					if (!parsed) {
						new Notice("That doesn't look like a Filen Cloud Sync setup link");
						return;
					}
					// Email only fills a LOCAL blank — never overwrites, and the
					// import never connects or stores credentials.
					if (this.plugin.settings.email.trim().length === 0 && parsed.email) {
						this.plugin.settings.email = parsed.email;
					}
					this.plugin.settings.remoteFolder = parsed.remoteFolder;
					applyPrefs(this.plugin.settings, parsed.prefs);
					await this.plugin.saveSettings();
					new Notice("Setup imported — now connect with your Filen password");
					this.refresh(); // structural change: several fields moved
				}));

		new Setting(containerEl).setName("Filters & guards").setHeading();

		new Setting(containerEl)
			.setName("Exclude dot files")
			.setDesc("Skip files and folders whose names start with a dot")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.excludeDotFiles)
				.onChange(async value => {
					this.plugin.settings.excludeDotFiles = value;
					await this.plugin.saveSettings();
					this.plugin.onSharedSettingChanged(); // shared key (v0.5.0)
				}));

		new Setting(containerEl)
			.setName("Ignore patterns")
			.setDesc("Gitignore-style patterns, one per line. A .filenignore file in the vault root is also honored.")
			.addTextArea(area => {
				area.setPlaceholder("e.g. private/**\n*.tmp")
					.setValue(this.plugin.settings.ignorePatterns)
					.onChange(async value => {
						this.plugin.settings.ignorePatterns = value;
						await this.plugin.saveSettings();
						this.plugin.onSharedSettingChanged(); // shared key (v0.5.0)
					});
				area.inputEl.rows = 4;
			});

		new Setting(containerEl)
			.setName("Ignored folders")
			.setDesc("Folders that are never synced, in either direction. Ignored is not deleted: contents stay untouched on both sides.")
			.addText(text => {
				text.setPlaceholder("folder/subfolder");
				this.folderInput = text;
				new FolderSuggest(this.app, text.inputEl, () => this.plugin.settings, folder => {
					text.setValue(folder.path);
					void this.addIgnoredFolder(folder.path);
					text.setValue("");
				});
			})
			.addButton(button => button
				.setButtonText("Add")
				.onClick(async () => {
					const value = this.folderInput?.getValue() ?? "";
					await this.addIgnoredFolder(value);
					this.folderInput?.setValue("");
				}));
		this.renderIgnoredFolderChips(containerEl);

		let skipSizeText: TextComponent | null = null;
		new Setting(containerEl)
			.setName("Skip large files")
			.setDesc("Skip files larger than N megabytes (they are left untouched on both sides)")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.skipLargeFiles)
				.onChange(async value => {
					this.plugin.settings.skipLargeFiles = value;
					await this.plugin.saveSettings();
					skipSizeText?.setDisabled(!value);
				}))
			.addText(text => {
				skipSizeText = text;
				text.setPlaceholder("50")
					.setValue(String(this.plugin.settings.skipSizeLargerThanMB))
					.onChange(async value => {
						const mb = Number(value);
						if (Number.isFinite(mb) && mb >= 1) {
							this.plugin.settings.skipSizeLargerThanMB = Math.floor(mb);
							await this.plugin.saveSettings();
						}
					});
				text.setDisabled(!this.plugin.settings.skipLargeFiles);
			});

		let guardText: TextComponent | null = null;
		new Setting(containerEl)
			.setName("Mass-change guard")
			.setDesc("Abort a sync if deletes plus modifications exceed N percent of all files")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.massChangeGuard)
				.onChange(async value => {
					this.plugin.settings.massChangeGuard = value;
					await this.plugin.saveSettings();
					guardText?.setDisabled(!value);
				}))
			.addText(text => {
				guardText = text;
				text.setPlaceholder("50")
				.setValue(String(this.plugin.settings.massChangeAbortPercent))
				.onChange(async value => {
					const pct = Number(value);
					if (Number.isFinite(pct) && pct >= 1 && pct <= 100) {
						this.plugin.settings.massChangeAbortPercent = Math.floor(pct);
						await this.plugin.saveSettings();
					}
				});
				text.setDisabled(!this.plugin.settings.massChangeGuard);
			});

		new Setting(containerEl)
			.setName("Debug log")
			.setDesc(
				"Write verbose diagnostics to the developer console (Ctrl/Cmd+Shift+I → Console) "
				+ "and the sync log. Logs include vault file paths — avoid sharing them publicly. "
				+ "Secrets (password, keys, tokens) are never logged.",
			)
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.debugLog)
				.onChange(async value => {
					this.plugin.settings.debugLog = value;
					setDebugLogging(value);
					await this.plugin.saveSettings();
				}));

		// v0.8.1: About block — version read from the manifest at RUNTIME
		// (never hardcoded), links to the repo + issue tracker.
		const about = containerEl.createDiv({ cls: "filen-cloud-sync-about" });
		about.appendText(`Filen Cloud Sync ${this.plugin.manifest.version} · by `);
		about.createEl("a", {
			text: "Real-Fruit-Snacks",
			href: "https://github.com/Real-Fruit-Snacks",
		});
		about.appendText(" · ");
		about.createEl("a", {
			text: "GitHub",
			href: "https://github.com/Real-Fruit-Snacks/obsidian-filen-cloud-sync",
		});
		about.appendText(" · ");
		about.createEl("a", {
			text: "Report an issue",
			href: "https://github.com/Real-Fruit-Snacks/obsidian-filen-cloud-sync/issues",
		});
	}

	/** Add an ignored folder: normalize (NFC, trim slashes), reject junk. */
	private async addIgnoredFolder(raw: string): Promise<void> {
		const path = normalizeIgnoredFolder(raw);
		if (path.length === 0) {
			new Notice("Enter a folder path first");
			return;
		}
		if (path === normalizeVaultPath(this.app.vault.configDir)) {
			new Notice("The Obsidian config folder is already excluded");
			return;
		}
		if (this.plugin.settings.ignoredFolders.includes(path)) {
			new Notice(`${path} is already ignored`);
			return;
		}
		this.plugin.settings.ignoredFolders.push(path);
		await this.plugin.saveSettings();
		this.plugin.onSharedSettingChanged(); // shared key (v0.5.0)
		this.refresh();
	}

	private async removeIgnoredFolder(path: string): Promise<void> {
		this.plugin.settings.ignoredFolders =
			this.plugin.settings.ignoredFolders.filter(folder => folder !== path);
		await this.plugin.saveSettings();
		this.plugin.onSharedSettingChanged(); // shared key (v0.5.0)
		this.refresh();
	}

	private renderIgnoredFolderChips(containerEl: HTMLElement): void {
		const list = containerEl.createDiv({ cls: "filen-cloud-sync-ignored-list" });
		if (this.plugin.settings.ignoredFolders.length === 0) {
			list.createDiv({ cls: "filen-cloud-sync-ignored-empty" })
				.setText("No ignored folders.");
			return;
		}
		for (const path of this.plugin.settings.ignoredFolders) {
			const chip = list.createDiv({ cls: "filen-cloud-sync-ignored-chip" });
			chip.createSpan({ cls: "filen-cloud-sync-ignored-path" }).setText(path);
			const remove = chip.createEl("button", { cls: "filen-cloud-sync-ignored-remove" });
			remove.setText("Remove");
			remove.setAttribute("aria-label", `Stop ignoring ${path}`);
			remove.addEventListener("click", () => void this.removeIgnoredFolder(path));
		}
	}

	private async connectFlow(buttonEl: HTMLButtonElement, httpFn?: HttpFn): Promise<void> {
		const email = this.plugin.settings.email.trim();
		const password = this.passwordValue;
		if (email.length === 0 || password.length === 0) {
			new Notice("Enter your Filen email and password first");
			return;
		}
		buttonEl.disabled = true;
		const notice = new Notice("Connecting to Filen…", 0);
		try {
			const client = new FilenClient(httpFn ?? obsidianHttp);
			const credentials = await client.connect(
				email,
				password,
				this.twoFactorValue.length > 0 ? this.twoFactorValue : undefined,
			);
			// Resolve/create the remote folder chain and fingerprint it.
			const chain = resolveRemoteFolder(
				this.plugin.settings.remoteFolder, this.app.vault.getName(),
			);
			credentials.syncRootUuid = await client.ensureFolderChain(
				credentials.rootUuid, chain, loadDeviceId(this.app),
			);
			if (this.plugin.settings.memoryOnlyCredentials) {
				// Memory-only mode: keys live in the plugin instance, never on disk.
				clearCredentials(this.app);
				this.plugin.setMemoryCredentials(credentials);
			} else {
				saveCredentials(this.app, credentials);
			}
			this.passwordValue = "";
			this.twoFactorValue = "";
			// First-run role declaration (v0.7.2): the direction chosen in the
			// connect form applies from the very first sync.
			this.plugin.settings.syncDirection = this.connectDirection;
			await this.plugin.saveSettings();
			notice.hide();
			new Notice(`Connected as ${email} — remote folder "${chain}" ready`);
			this.plugin.onConnected();
			this.refresh();
		} catch (e) {
			notice.hide();
			if (e instanceof FilenApiError && (e.code === "wrong_2fa" || e.message.toLowerCase().includes("2fa"))) {
				new Notice("Invalid 2FA code — try again with a fresh code");
			} else if (e instanceof FilenApiError) {
				new Notice(`Filen login failed: ${e.message}`);
			} else {
				new Notice(`Connection failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		} finally {
			buttonEl.disabled = false;
		}
	}
}

/** Suggest-as-you-type folder picker for the "Ignored folders" input. */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(
		app: App,
		inputEl: HTMLInputElement,
		private readonly getSettings: () => FilenSyncSettings,
		private readonly onPick: (folder: TFolder) => void,
	) {
		super(app, inputEl);
	}

	getSuggestions(inputStr: string): TFolder[] {
		const query = inputStr.toLowerCase();
		const ignored = new Set(this.getSettings().ignoredFolders);
		const configDir = normalizeVaultPath(this.app.vault.configDir);
		return this.app.vault.getAllFolders(false)
			.filter(folder => folder.path.length > 0)
			.filter(folder => normalizeVaultPath(folder.path) !== configDir)
			.filter(folder => !ignored.has(normalizeVaultPath(folder.path)))
			.filter(folder => folder.path.toLowerCase().includes(query));
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}

	selectSuggestion(folder: TFolder): void {
		this.onPick(folder);
		this.close();
	}
}
