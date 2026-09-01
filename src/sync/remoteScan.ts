/**
 * Remote scan: /v3/dir/tree + metadata decryption → RemoteTree (the design docs).
 * Paths built by walking parent pointers; root folder tuple has parent "base".
 * Case-insensitive match, first wins.
 */

import { FilenCryptoError } from "../filen/crypto";
import type { FilenClient } from "../filen/client";
import type { DirTreeResponse } from "../filen/types";
import { detectCaseCollisions, normalizeVaultPath } from "../util";
import type { RemoteFile, RemoteTree } from "./types";

export interface RemoteScanResult {
	tree: RemoteTree;
	skipped: Array<{ path: string; reason: string }>;
	collisions: string[][];
}

/**
 * Thrown when an entry INSIDE the sync root cannot be decrypted. Silently
 * skipping it would make the planner read the entry as remotely-deleted and
 * trash the local copy — data loss — so the whole run must abort instead.
 */
export class RemoteScanError extends Error {
	constructor(
		message: string,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "RemoteScanError";
	}
}

export async function scanRemote(client: FilenClient, syncRootUuid: string, deviceId: string): Promise<RemoteScanResult> {
	const raw = await client.dirTree(syncRootUuid, deviceId);
	return buildRemoteTree(client, raw, syncRootUuid);
}

export async function buildRemoteTree(
	client: FilenClient,
	raw: DirTreeResponse,
	syncRootUuid: string,
): Promise<RemoteScanResult> {
	const skipped: Array<{ path: string; reason: string }> = [];

	// uuid → { name, parent }
	const folderInfo = new Map<string, { name: string; parent: string }>();
	for (const tuple of raw.folders) {
		const [uuid, nameEnc, parent] = tuple;
		if (uuid === syncRootUuid || parent === "base") {
			// The sync root itself — path "".
			folderInfo.set(uuid, { name: "", parent: "" });
			continue;
		}
		try {
			const name = await client.decryptFolderName(nameEnc);
			folderInfo.set(uuid, { name, parent });
		} catch (e) {
			if (e instanceof FilenCryptoError) {
				// The dir/tree call is scoped to the sync root, so this folder
				// is INSIDE it — skipping would read as "remotely deleted".
				throw new RemoteScanError(
					`undecryptable remote folder name (uuid ${uuid}) — aborting to protect local files; `
					+ "check that you are connected with the correct account/keys",
					e,
				);
			}
			throw e;
		}
	}
	folderInfo.set(syncRootUuid, { name: "", parent: "" });

	// Resolve folder paths by walking parents (with cycle protection).
	const folderPathByUuid = new Map<string, string>();
	folderPathByUuid.set(syncRootUuid, "");
	const resolveFolder = (uuid: string, depth = 0): string | null => {
		const cached = folderPathByUuid.get(uuid);
		if (cached !== undefined) return cached;
		if (depth > 128) return null;
		const info = folderInfo.get(uuid);
		if (!info) return null;
		const parentPath = info.parent === "" || info.parent === "base" || info.parent === syncRootUuid
			? ""
			: resolveFolder(info.parent, depth + 1);
		if (parentPath === null) return null;
		const path = parentPath === "" ? info.name : `${parentPath}/${info.name}`;
		const normalized = normalizeVaultPath(path);
		folderPathByUuid.set(uuid, normalized);
		return normalized;
	};

	const folders = new Map<string, string>();
	folders.set("", syncRootUuid);
	for (const uuid of folderInfo.keys()) {
		const path = resolveFolder(uuid);
		if (path === null) continue;
		if (!folders.has(path)) folders.set(path, uuid);
	}

	const files = new Map<string, RemoteFile>();
	const allPaths: string[] = [];
	for (const tuple of raw.files) {
		const [uuid, bucket, region, chunks, parent, metadataEnc] = tuple;
		let file: RemoteFile | null = null;
		try {
			const meta = await client.decryptFileMetadata(metadataEnc);
			const parentPath = resolveFolder(parent);
			if (parentPath === null) {
				skipped.push({ path: uuid, reason: "unresolvable parent folder" });
				continue;
			}
			const path = normalizeVaultPath(
				parentPath === "" ? meta.name : `${parentPath}/${meta.name}`,
			);
			file = {
				path,
				uuid,
				parent,
				size: meta.size,
				lastModified: meta.lastModified,
				chunks,
				bucket,
				region,
				key: meta.key,
			};
			if (meta.hash) file.hash = meta.hash;
			if (meta.mime) file.mime = meta.mime;
			if (meta.creation !== undefined) file.creation = meta.creation;
		} catch (e) {
			if (e instanceof FilenCryptoError) {
				// Inside the sync root: never skip — the planner would trash
				// the local copy as "remotely deleted" (data loss).
				throw new RemoteScanError(
					`undecryptable remote file metadata (uuid ${uuid}) — aborting to protect local files; `
					+ "check that you are connected with the correct account/keys",
					e,
				);
			}
			throw e;
		}
		if (files.has(file.path)) continue; // case-insensitive first wins (exact dup path)
		files.set(file.path, file);
		allPaths.push(file.path);
	}

	// Case-insensitive collisions (differing only by case): first wins.
	const collisions = detectCaseCollisions(allPaths);
	for (const group of collisions) {
		for (let i = 1; i < group.length; i++) {
			const loser = group[i] as string;
			files.delete(loser);
			skipped.push({ path: loser, reason: `case collision with ${group[0] as string}` });
		}
	}

	return { tree: { files, folders }, skipped, collisions };
}
