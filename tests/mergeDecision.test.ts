/**
 * Merge decision mapping (v0.4.0 feature E): each merge-view button maps to
 * the exact op set the engine must execute. Pure planner-level tests — the
 * engine's ask-mode integration lives in engine.test.ts.
 */

import { describe, expect, it } from "vitest";
import { mergeDecisionOps } from "../src/sync/planner";
import type { LocalFile, RemoteFile } from "../src/sync/types";
import { conflictPathFor } from "../src/util";

const T0 = 1_700_000_000_000;

const local: LocalFile = { path: "note.md", mtime: T0 + 5000, size: 100 };
const remote: RemoteFile = {
	path: "note.md",
	uuid: "remote-uuid-1",
	parent: "parent",
	size: 110,
	lastModified: T0 + 3000,
	chunks: 1,
	bucket: "bucket",
	region: "region",
	key: "file-key",
};

describe("mergeDecisionOps", () => {
	it("keep_local → single upload; remote loser trashed AFTER the upload", () => {
		const ops = mergeDecisionOps("keep_local", "note.md", local, remote, "keep_both");
		expect(ops).toHaveLength(1);
		expect(ops[0]?.kind).toBe("upload");
		expect(ops[0]?.path).toBe("note.md");
		expect(ops[0]?.trashRemoteUuidAfter).toBe("remote-uuid-1");
	});

	it("keep_remote → trashLocal + download of the remote version", () => {
		const ops = mergeDecisionOps("keep_remote", "note.md", local, remote, "keep_both");
		expect(ops.map(op => op.kind)).toEqual(["trashLocal", "download"]);
		expect(ops[0]?.path).toBe("note.md");
		expect(ops[1]?.path).toBe("note.md");
		expect(ops[1]?.remote?.uuid).toBe("remote-uuid-1");
		expect(ops[1]?.trashRemoteUuidAfter).toBeUndefined();
	});

	it("keep_both with keep_both policy → the default policy behavior (conflict copy)", () => {
		const ops = mergeDecisionOps("keep_both", "note.md", local, remote, "keep_both");
		// Local is newer: upload original + download remote to a conflict name.
		expect(ops.map(op => op.kind)).toEqual(["upload", "download"]);
		expect(ops[0]?.path).toBe("note.md");
		expect(ops[1]?.path).toBe(conflictPathFor("note.md", T0 + 3000));
		expect(ops.some(op => op.path.includes(" (conflict "))).toBe(true);
	});

	it("keep_both with keep_newer policy → the default policy behavior (loser trashed)", () => {
		const ops = mergeDecisionOps("keep_both", "note.md", local, remote, "keep_newer");
		// Local newer: upload + trash remote loser; never a conflict copy.
		expect(ops.map(op => op.kind)).toEqual(["upload"]);
		expect(ops[0]?.trashRemoteUuidAfter).toBe("remote-uuid-1");
		expect(ops.some(op => op.path.includes(" (conflict "))).toBe(false);
	});

	it("keep_both honors the mtime winner (remote newer → local renamed)", () => {
		const olderLocal: LocalFile = { path: "note.md", mtime: T0 + 1000, size: 100 };
		const ops = mergeDecisionOps("keep_both", "note.md", olderLocal, remote, "keep_both");
		expect(ops.map(op => op.kind)).toEqual(["renameLocal", "download", "upload"]);
		expect(ops[0]?.toPath).toBe(conflictPathFor("note.md", T0 + 1000));
	});

	it("concat → single plain upload; remote NEVER trashed", () => {
		const ops = mergeDecisionOps("concat", "note.md", local, remote, "keep_both");
		expect(ops).toHaveLength(1);
		expect(ops[0]?.kind).toBe("upload");
		expect(ops[0]?.path).toBe("note.md");
		expect(ops[0]?.trashRemoteUuidAfter).toBeUndefined();
		expect(ops[0]?.remote).toBeUndefined();
	});

	it("every decision tags ops with the conflict path (engine op grouping)", () => {
		for (const decision of ["keep_local", "keep_remote", "keep_both", "concat"] as const) {
			const ops = mergeDecisionOps(decision, "note.md", local, remote, "keep_both");
			for (const op of ops) {
				expect(op.conflict?.path).toBe("note.md");
			}
		}
	});
});
