/**
 * Remote scan tests: undecryptable entries INSIDE the sync root must
 * hard-fail the run (never silently skip — the planner would read the entry
 * as remotely-deleted and trash the local copy = data loss).
 */

import { describe, expect, it } from "vitest";
import type { FilenClient } from "../src/filen/client";
import { FilenCryptoError } from "../src/filen/crypto";
import type { DirTreeResponse } from "../src/filen/types";
import { buildRemoteTree, RemoteScanError } from "../src/sync/remoteScan";

const ROOT = "root-uuid";

function mockClient(overrides: {
	folderName?: (nameEnc: string) => Promise<string>;
	fileMetadata?: (metadataEnc: string) => Promise<Record<string, unknown>>;
}): FilenClient {
	return {
		decryptFolderName: overrides.folderName ?? (async () => "folder"),
		decryptFileMetadata: overrides.fileMetadata ?? (async () => ({
			name: "note.md", size: 10, mime: "text/markdown", key: "k", lastModified: 1700000000000,
		})),
	} as unknown as FilenClient;
}

function treeWith(files: DirTreeResponse["files"], folders: DirTreeResponse["folders"]): DirTreeResponse {
	return { files, folders: [[ROOT, "default", "base"], ...folders] };
}

describe("remoteScan hard-fail", () => {
	it("undecryptable file metadata inside the sync root aborts the scan", async () => {
		const client = mockClient({
			fileMetadata: async () => {
				throw new FilenCryptoError("could not decrypt metadata with any of 1 key(s)");
			},
		});
		const raw = treeWith(
			[["file-uuid", "bucket", "region", 1, ROOT, "bad-metadata", 2, 0]],
			[],
		);
		await expect(buildRemoteTree(client, raw, ROOT))
			.rejects.toThrow(RemoteScanError);
		await expect(buildRemoteTree(client, raw, ROOT))
			.rejects.toThrow(/undecryptable remote file metadata/);
	});

	it("undecryptable folder name inside the sync root aborts the scan", async () => {
		const client = mockClient({
			folderName: async () => {
				throw new FilenCryptoError("could not decrypt metadata with any of 1 key(s)");
			},
		});
		const raw = treeWith([], [["sub-uuid", "bad-name", ROOT]]);
		await expect(buildRemoteTree(client, raw, ROOT))
			.rejects.toThrow(/undecryptable remote folder name/);
	});

	it("decryptable tree scans normally; unresolvable parents are still skipped silently", async () => {
		const client = mockClient({
			folderName: async () => "sub",
			fileMetadata: async enc => ({
				name: enc === "meta-a" ? "a.md" : "ghost.md",
				size: 10, mime: "text/markdown", key: "k", lastModified: 1700000000000,
			}),
		});
		const raw = treeWith(
			[
				["uuid-a", "bucket", "region", 1, "sub-uuid", "meta-a", 2, 0],
				// parent uuid does not exist → unresolvable (not a decrypt failure)
				["uuid-ghost", "bucket", "region", 1, "missing-parent", "meta-g", 2, 0],
			],
			[["sub-uuid", "enc-sub", ROOT]],
		);
		const result = await buildRemoteTree(client, raw, ROOT);
		expect([...result.tree.files.keys()]).toEqual(["sub/a.md"]);
		expect(result.tree.folders.get("sub")).toBe("sub-uuid");
		expect(result.skipped.some(s => s.reason === "unresolvable parent folder")).toBe(true);
	});
});
