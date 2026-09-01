/**
 * Minimal obsidian mock for unit tests (vitest alias). Only the runtime
 * values actually touched by the modules under test are provided; App/Vault
 * are faked structurally in the test files themselves.
 */

export const Platform = {
	isMobileApp: false,
	isDesktopApp: true,
};

/** requestUrl mock: set an implementation per test. */
let requestUrlImpl: (req: unknown) => Promise<unknown> = async () => {
	throw new Error("requestUrl mock not configured");
};

export function setRequestUrlImpl(fn: (req: unknown) => Promise<unknown>): void {
	requestUrlImpl = fn;
}

export const requestUrl = (req: unknown): Promise<unknown> => requestUrlImpl(req);

/** Minimal structural stubs so UI modules import cleanly (never rendered). */
export class App {}

export class Modal {
	contentEl: unknown = null;

	constructor(public app: App) {}

	setTitle(_title: string): void { /* stub */ }

	open(): void { /* stub */ }

	close(): void { /* stub */ }

	onOpen(): void { /* stub */ }

	onClose(): void { /* stub */ }
}

export class Setting {
	constructor(public containerEl: unknown) {}

	addButton(fn: (button: unknown) => unknown): this {
		fn({ setButtonText: () => this, onClick: () => this });
		return this;
	}
}
