/**
 * Planner tests (the design docs): every decision-table row, both conflict
 * policies, mtime ordering, tie→local, modify-beats-delete both directions,
 * seed mode, mass-change abort, equality short-circuit, hash-confirm.
 */

import { describe, expect, it } from "vitest";
import { localChanged, planSync, remoteChanged } from "../src/sync/planner";
import {
	BaseRecord,
	LocalFile,
	LocalTree,
	PlannerOptions,
	RemoteFile,
	RemoteTree,
	SyncOp,
} from "../src/sync/types";

const T0 = 1_700_000_000_000; // fixed epoch ms

function lf(path: string, mtime = T0, size = 100): LocalFile {
	return { path, mtime, size };
}

function rf(path: string, uuid = `uuid-${path}`, mtime = T0, size = 100, hash?: string): RemoteFile {
	const f: RemoteFile = {
		path, uuid, parent: "", size, lastModified: mtime,
		chunks: 1, bucket: "b", region: "r", key: "k",
	};
	if (hash) f.hash = hash;
	return f;
}

function base(localMtime = T0, localSize = 100, remoteUuid = "uuid-a", remoteMtime = T0, remoteSize = 100): BaseRecord {
	return { localMtime, localSize, remoteUuid, remoteMtime, remoteSize };
}

function localTree(...files: LocalFile[]): LocalTree {
	return { files: new Map(files.map(f => [f.path, f])), folders: new Set(), skipped: [], excluded: new Set<string>(), collisions: [] };
}

/** Local tree with excluded-but-present paths (ignored files still in the vault). */
function localTreeExcluded(excluded: string[], ...files: LocalFile[]): LocalTree {
	const tree = localTree(...files);
	tree.excluded = new Set(excluded);
	return tree;
}

function remoteTree(...files: RemoteFile[]): RemoteTree {
	return { files: new Map(files.map(f => [f.path, f])), folders: new Map([["", "root-uuid"]]) };
}

function opts(overrides: Partial<PlannerOptions> = {}): PlannerOptions {
	return { conflictPolicy: "keep_both", massChangeAbortPercent: 100, ...overrides };
}

function kinds(planOps: SyncOp[]): string[] {
	return planOps.map(op => op.kind);
}

describe("change detection primitives", () => {
	it("localChanged: whole-second mtime + size", () => {
		const b = base(T0);
		expect(localChanged(lf("a", T0 + 999), b)).toBe(false); // same whole second
		expect(localChanged(lf("a", T0 + 1000), b)).toBe(true);
		expect(localChanged(lf("a", T0, 101), b)).toBe(true);
		expect(localChanged(lf("a", T0), undefined as unknown as BaseRecord)).toBe(true);
	});

	it("remoteChanged: new uuid only", () => {
		const b = base(T0, 100, "u1");
		expect(remoteChanged(rf("a", "u1", T0 + 5000, 999), b)).toBe(false);
		expect(remoteChanged(rf("a", "u2"), b)).toBe(true);
	});
});

describe("decision table — both exist", () => {
	it("neither changed → nothing", () => {
		const plan = planSync(
			localTree(lf("a.md")), remoteTree(rf("a.md", "u1")),
			new Map([["a.md", base(T0, 100, "u1")]]), opts(),
		);
		expect(plan.ops).toHaveLength(0);
	});

	it("local changed only → upload", () => {
		const plan = planSync(
			localTree(lf("a.md", T0 + 5000)), remoteTree(rf("a.md", "u1")),
			new Map([["a.md", base(T0, 100, "u1")]]), opts(),
		);
		expect(kinds(plan.ops)).toEqual(["upload"]);
	});

	it("remote changed only → download", () => {
		// different size so the equality short-circuit does not fire
		const plan = planSync(
			localTree(lf("a.md")), remoteTree(rf("a.md", "u2", T0, 101)),
			new Map([["a.md", base(T0, 100, "u1")]]), opts(),
		);
		expect(kinds(plan.ops)).toEqual(["download"]);
		expect(plan.ops[0]?.remote?.uuid).toBe("u2");
	});

	it("both changed → conflict", () => {
		const plan = planSync(
			localTree(lf("a.md", T0 + 5000)), remoteTree(rf("a.md", "u2", T0 + 3000)),
			new Map([["a.md", base(T0, 100, "u1")]]), opts(),
		);
		expect(plan.conflicts).toHaveLength(1);
	});

	it("no base (both new) → conflict-created", () => {
		const plan = planSync(
			localTree(lf("a.md", T0, 50)), remoteTree(rf("a.md", "u1", T0 + 9999, 60)),
			new Map(), opts({ massChangeAbortPercent: 100 }),
		);
		expect(plan.conflicts).toHaveLength(1);
		expect(plan.conflicts[0]?.policy).toBe("keep_both"); // seed both-nonempty forces keep_both
	});

	it("equality short-circuit: same size + whole-second mtime → refreshBase even if base disagrees", () => {
		const plan = planSync(
			localTree(lf("a.md", T0 + 500)), remoteTree(rf("a.md", "u2", T0 + 900)),
			new Map([["a.md", base(T0, 100, "u1")]]), opts(),
		);
		expect(kinds(plan.ops)).toEqual(["refreshBase"]);
	});

	it("hash-confirm: sizes equal, mtimes differ, hashes equal → refreshBase, no transfer", () => {
		const remote = rf("a.md", "u2", T0 + 60_000, 100, "hashABC");
		const plan = planSync(
			localTree(lf("a.md", T0)), remoteTree(remote),
			new Map([["a.md", base(T0, 100, "u1")]]),
			opts({ localHashes: new Map([["a.md", "hashABC"]]) }),
		);
		expect(kinds(plan.ops)).toEqual(["refreshBase"]);
	});

	it("hash mismatch → normal change detection (download when remote changed)", () => {
		const remote = rf("a.md", "u2", T0 + 60_000, 100, "hashABC");
		const plan = planSync(
			localTree(lf("a.md", T0)), remoteTree(remote),
			new Map([["a.md", base(T0, 100, "u1")]]),
			opts({ localHashes: new Map([["a.md", "hashXYZ"]]) }),
		);
		expect(kinds(plan.ops)).toEqual(["download"]);
	});
});

describe("decision table — one side only", () => {
	it("local only, no base → upload", () => {
		const plan = planSync(localTree(lf("a.md")), remoteTree(), new Map([["x", base()]]), opts());
		// x is history-only → dropBase; a.md → upload
		expect(kinds(plan.ops).sort()).toEqual(["dropBase", "upload"]);
	});

	it("local only, base exists, local unchanged → trash local (remote deleted it)", () => {
		const plan = planSync(
			localTree(lf("a.md")), remoteTree(),
			new Map([["a.md", base(T0, 100, "u1")]]), opts(),
		);
		expect(kinds(plan.ops)).toEqual(["trashLocal"]);
	});

	it("local only, base exists, local changed → upload (modify-beats-delete)", () => {
		const plan = planSync(
			localTree(lf("a.md", T0 + 5000)), remoteTree(),
			new Map([["a.md", base(T0, 100, "u1")]]), opts(),
		);
		expect(kinds(plan.ops)).toEqual(["upload"]);
	});

	it("remote only, no base → download", () => {
		const plan = planSync(localTree(), remoteTree(rf("a.md", "u1")), new Map(), opts());
		expect(kinds(plan.ops)).toEqual(["download"]);
		expect(plan.seedMode).toBe("download-all");
	});

	it("remote only, base exists, remote unchanged → trash remote", () => {
		const plan = planSync(
			localTree(), remoteTree(rf("a.md", "u1")),
			new Map([["a.md", base(T0, 100, "u1")]]), opts(),
		);
		expect(kinds(plan.ops)).toEqual(["trashRemote"]);
	});

	it("remote only, base exists, remote changed → download (modify-beats-delete)", () => {
		const plan = planSync(
			localTree(), remoteTree(rf("a.md", "u2")),
			new Map([["a.md", base(T0, 100, "u1")]]), opts(),
		);
		expect(kinds(plan.ops)).toEqual(["download"]);
	});

	it("history-only → drop base record", () => {
		const plan = planSync(localTree(), remoteTree(), new Map([["a.md", base()]]), opts());
		expect(kinds(plan.ops)).toEqual(["dropBase"]);
	});
});

describe("conflict policies", () => {
	const conflictInputs = (policy: "keep_both" | "keep_newer") => ({
		local: localTree(lf("a.md", T0 + 5000, 110)),
		remote: remoteTree(rf("a.md", "u2", T0 + 3000, 120)),
		base: new Map([["a.md", base(T0, 100, "u1")]]),
		opts: opts({ conflictPolicy: policy }),
	});

	it("keep_both: local newer → upload original + download remote to conflict name", () => {
		const { local, remote, base: b, opts: o } = conflictInputs("keep_both");
		const plan = planSync(local, remote, b, o);
		expect(plan.conflicts[0]?.winner).toBe("local");
		expect(kinds(plan.ops)).toEqual(["upload", "download"]);
		const dl = plan.ops.find(op => op.kind === "download");
		expect(dl?.path).toMatch(/^a \(conflict \d{4}-\d{2}-\d{2} \d{4}\)\.md$/);
		// loser (remote) mtime determines the suffix
		expect(dl?.path).toContain(new Date((T0 + 3000) - ((T0 + 3000) % 1000)).toISOString().slice(0, 10));
	});

	it("keep_both: remote newer → rename local loser + download + upload loser copy", () => {
		const plan = planSync(
			localTree(lf("a.md", T0 + 1000, 110)),
			remoteTree(rf("a.md", "u2", T0 + 9000, 120)),
			new Map([["a.md", base(T0, 100, "u1")]]), opts({ conflictPolicy: "keep_both" }),
		);
		expect(plan.conflicts[0]?.winner).toBe("remote");
		// phase-sorted: rename (5) → upload loser copy (6) → download winner (7)
		expect(kinds(plan.ops)).toEqual(["renameLocal", "upload", "download"]);
		const rename = plan.ops.find(op => op.kind === "renameLocal");
		expect(rename?.path).toBe("a.md");
		expect(rename?.toPath).toMatch(/^a \(conflict .*\)\.md$/);
		const upload = plan.ops.find(op => op.kind === "upload");
		expect(upload?.path).toBe(rename?.toPath);
	});

	it("keep_both: same-second tie → local keeps the original name", () => {
		const plan = planSync(
			localTree(lf("a.md", T0 + 400, 110)),
			remoteTree(rf("a.md", "u2", T0 + 900, 120)),
			new Map([["a.md", base(T0, 100, "u1")]]), opts({ conflictPolicy: "keep_both" }),
		);
		expect(plan.conflicts[0]?.winner).toBe("local");
		expect(plan.ops.find(op => op.kind === "upload")?.path).toBe("a.md");
	});

	it("keep_newer: local newer → upload, trashing the remote loser afterwards", () => {
		const { local, remote, base: b, opts: o } = conflictInputs("keep_newer");
		const plan = planSync(local, remote, b, o);
		expect(kinds(plan.ops)).toEqual(["upload"]);
		expect(plan.ops[0]?.trashRemoteUuidAfter).toBe("u2");
		expect(plan.conflicts[0]?.policy).toBe("keep_newer");
	});

	it("keep_newer: remote newer → trash local loser then download", () => {
		const plan = planSync(
			localTree(lf("a.md", T0 + 1000, 110)),
			remoteTree(rf("a.md", "u2", T0 + 9000, 120)),
			new Map([["a.md", base(T0, 100, "u1")]]), opts({ conflictPolicy: "keep_newer" }),
		);
		expect(kinds(plan.ops)).toEqual(["trashLocal", "download"]);
	});
});

describe("seed mode", () => {
	it("base empty + remote empty → upload-all", () => {
		const plan = planSync(localTree(lf("a.md"), lf("b.md")), remoteTree(), new Map(), opts());
		expect(plan.seedMode).toBe("upload-all");
		expect(kinds(plan.ops).sort()).toEqual(["upload", "upload"]);
	});

	it("base empty + local empty → download-all", () => {
		const plan = planSync(localTree(), remoteTree(rf("a.md", "u1")), new Map(), opts());
		expect(plan.seedMode).toBe("download-all");
		expect(kinds(plan.ops)).toEqual(["download"]);
	});

	it("base empty + both non-empty → shared paths are keep_both conflicts regardless of policy", () => {
		const plan = planSync(
			localTree(lf("shared.md", T0, 50), lf("only-local.md")),
			remoteTree(rf("shared.md", "u1", T0 + 9999, 60), rf("only-remote.md", "u2")),
			new Map(), opts({ conflictPolicy: "keep_newer" }),
		);
		expect(plan.seedMode).toBe("both-nonempty");
		expect(plan.conflicts).toHaveLength(1);
		expect(plan.conflicts[0]?.policy).toBe("keep_both");
		// uniques still transfer normally
		expect(plan.ops.some(op => op.kind === "upload" && op.path === "only-local.md")).toBe(true);
		expect(plan.ops.some(op => op.kind === "download" && op.path === "only-remote.md")).toBe(true);
		// identical files don't conflict
		const plan2 = planSync(
			localTree(lf("same.md", T0, 50)),
			remoteTree(rf("same.md", "u1", T0 + 500, 50)),
			new Map(), opts(),
		);
		expect(plan2.conflicts).toHaveLength(0);
		expect(kinds(plan2.ops)).toEqual(["refreshBase"]);
	});
});

describe("mass-change guard", () => {
	it("aborts when deletes+modifies exceed the threshold", () => {
		// 3 of 4 files would be locally trashed (remote wiped them)
		const files = ["a.md", "b.md", "c.md", "d.md"];
		const local = localTree(...files.map(f => lf(f)));
		const remote = remoteTree(rf("d.md", "uuid-d.md"));
		const baseMap = new Map(files.map(f => [f, base(T0, 100, `uuid-${f}`)]));
		const plan = planSync(local, remote, baseMap, opts({ massChangeAbortPercent: 50 }));
		expect(plan.aborted).toBe(true);
		expect(plan.abortReason).toMatch(/mass-change guard/);
	});

	it("does not abort under the threshold", () => {
		const files = ["a.md", "b.md", "c.md", "d.md"];
		const local = localTree(...files.map(f => lf(f)));
		const remote = remoteTree(...files.slice(1).map(f => rf(f, `uuid-${f}`)));
		const baseMap = new Map(files.map(f => [f, base(T0, 100, `uuid-${f}`)]));
		const plan = planSync(local, remote, baseMap, opts({ massChangeAbortPercent: 50 }));
		expect(plan.aborted).toBe(false);
		expect(kinds(plan.ops)).toEqual(["trashLocal"]);
	});

	it("manual override skips the guard", () => {
		const files = ["a.md", "b.md", "c.md", "d.md"];
		const local = localTree(...files.map(f => lf(f)));
		const remote = remoteTree(rf("d.md", "uuid-d.md"));
		const baseMap = new Map(files.map(f => [f, base(T0, 100, `uuid-${f}`)]));
		const plan = planSync(
			local, remote, baseMap,
			opts({ massChangeAbortPercent: 50, ignoreMassChangeGuard: true }),
		);
		expect(plan.aborted).toBe(false);
		expect(plan.ops.filter(op => op.kind === "trashLocal")).toHaveLength(3);
	});

	it("never triggers in seed mode", () => {
		const local = localTree(...Array.from({ length: 10 }, (_, i) => lf(`f${i}.md`)));
		const plan = planSync(local, remoteTree(), new Map(), opts({ massChangeAbortPercent: 1 }));
		expect(plan.aborted).toBe(false);
		expect(plan.seedMode).toBe("upload-all");
	});
});

describe("folders", () => {
	it("creates missing remote folders for uploads and local folders for downloads", () => {
		const local: LocalTree = {
			files: new Map([["sub/deep/a.md", lf("sub/deep/a.md")]]),
			folders: new Set(["sub", "sub/deep", "empty-local"]),
			skipped: [], excluded: new Set<string>(), collisions: [],
		};
		const remote: RemoteTree = {
			files: new Map([["rdir/b.md", rf("rdir/b.md", "u1")]]),
			folders: new Map([["", "root"], ["rdir", "uuid-rdir"], ["empty-remote", "uuid-er"]]),
		};
		const plan = planSync(local, remote, new Map(), opts());
		// upload-all seed (remote has files → not pure upload seed; it's both-nonempty)
		expect(plan.ops.some(op => op.kind === "mkdirRemote" && op.path === "sub")).toBe(true);
		expect(plan.ops.some(op => op.kind === "mkdirRemote" && op.path === "sub/deep")).toBe(true);
		expect(plan.ops.some(op => op.kind === "mkdirRemote" && op.path === "empty-local")).toBe(true);
		expect(plan.ops.some(op => op.kind === "mkdirLocal" && op.path === "rdir")).toBe(true);
		expect(plan.ops.some(op => op.kind === "mkdirLocal" && op.path === "empty-remote")).toBe(true);
	});

	it("prunes previously-synced remote folders that vanished locally (deepest-first)", () => {
		const local: LocalTree = { files: new Map(), folders: new Set(), skipped: [], excluded: new Set<string>(), collisions: [] };
		const remote: RemoteTree = {
			files: new Map(),
			folders: new Map([["", "root"], ["gone", "uuid-gone"], ["gone/inner", "uuid-inner"]]),
		};
		const baseMap = new Map([["gone/inner/f.md", base()]]);
		const plan = planSync(local, remote, baseMap, opts());
		const prunes = plan.ops.filter(op => op.kind === "trashRemoteDir").map(op => op.path);
		expect(prunes).toEqual(["gone/inner", "gone"]); // deepest-first
	});

	it("does not prune brand-new remote folders (no base evidence) — downloads them instead", () => {
		const local: LocalTree = { files: new Map(), folders: new Set(), skipped: [], excluded: new Set<string>(), collisions: [] };
		const remote: RemoteTree = {
			files: new Map(),
			folders: new Map([["", "root"], ["fresh", "uuid-fresh"]]),
		};
		const plan = planSync(local, remote, new Map([["unrelated.md", base()]]), opts());
		expect(plan.ops.some(op => op.kind === "trashRemoteDir")).toBe(false);
		expect(plan.ops.some(op => op.kind === "mkdirLocal" && op.path === "fresh")).toBe(true);
	});
});

describe("excluded local files — ignored ≠ deleted", () => {
	it("file that grew past skipSizeLargerThanMB keeps its remote copy and base record", () => {
		// big.bin is present in base+remote but excluded from the local scan
		const local = localTreeExcluded(["big.bin"], lf("other.md"));
		const remote = remoteTree(rf("big.bin", "u1"), rf("other.md", "u2"));
		const baseMap = new Map([
			["big.bin", base(T0, 100, "u1")],
			["other.md", base(T0, 100, "u2")],
		]);
		const plan = planSync(local, remote, baseMap, opts());
		expect(plan.ops.filter(op => op.path === "big.bin")).toHaveLength(0);
		expect(plan.ops.some(op => op.kind === "trashRemote")).toBe(false);
		expect(plan.aborted).toBe(false);
	});

	it("toggling excludeDotFiles does not trash remote dotfiles", () => {
		const local = localTreeExcluded([".hidden.md", "sub/.secret.md"], lf("visible.md"));
		const remote = remoteTree(
			rf(".hidden.md", "u1"), rf("sub/.secret.md", "u2"), rf("visible.md", "u3"),
		);
		const baseMap = new Map([
			[".hidden.md", base(T0, 100, "u1")],
			["sub/.secret.md", base(T0, 100, "u2")],
			["visible.md", base(T0, 100, "u3")],
		]);
		const plan = planSync(local, remote, baseMap, opts());
		expect(plan.ops).toHaveLength(0); // visible.md unchanged; dotfiles suppressed
	});

	it("ignore-patterned folder: no file trash and no remote dir prune", () => {
		const local = localTreeExcluded(["private/diary.md"], lf("index.md"));
		const remote: RemoteTree = {
			files: new Map([
				["private/diary.md", rf("private/diary.md", "u1")],
				["index.md", rf("index.md", "u2")],
			]),
			folders: new Map([["", "root"], ["private", "uuid-private"]]),
		};
		const baseMap = new Map([
			["private/diary.md", base(T0, 100, "u1")],
			["index.md", base(T0, 100, "u2")],
		]);
		const plan = planSync(local, remote, baseMap, opts());
		expect(plan.ops.some(op => op.kind === "trashRemote")).toBe(false);
		expect(plan.ops.some(op => op.kind === "trashRemoteDir")).toBe(false);
		expect(plan.ops.filter(op => op.path.startsWith("private"))).toHaveLength(0);
	});

	it("excluded path present ONLY locally (no base, no remote) stays untracked — no upload, no dropBase", () => {
		const local = localTreeExcluded(["scratch.tmp"], lf("a.md"));
		const plan = planSync(local, remoteTree(rf("a.md", "u1")), new Map([["a.md", base(T0, 100, "u1")]]), opts());
		expect(plan.ops.filter(op => op.path === "scratch.tmp")).toHaveLength(0);
	});
});

describe("phase ordering", () => {
	it("orders ops: local deletes → remote deletes → mkdirs → renames → uploads → downloads → prunes", () => {
		// Construct a plan with several op kinds and verify global ordering.
		const local: LocalTree = {
			files: new Map([
				["del-local.md", lf("del-local.md")],
				["conflict.md", lf("conflict.md", T0 + 1000, 110)],
				["new.md", lf("new.md")],
			]),
			folders: new Set(["newfolder"]),
			skipped: [], excluded: new Set<string>(), collisions: [],
		};
		const remote: RemoteTree = {
			files: new Map([
				["del-remote.md", rf("del-remote.md", "uuid-del-remote.md")],
				["conflict.md", rf("conflict.md", "u2", T0 + 9000, 120)],
				["dl.md", rf("dl.md", "u3")],
			]),
			folders: new Map([["", "root"], ["gone", "uuid-gone"]]),
		};
		const baseMap = new Map([
			["del-local.md", base(T0, 100, "u1")],
			["del-remote.md", base(T0, 100, "uuid-del-remote.md")],
			["conflict.md", base(T0, 100, "u1")],
			["gone/f.md", base()],
		]);
		const plan = planSync(local, remote, baseMap, opts({ ignoreMassChangeGuard: true, massChangeAbortPercent: 50 }));
		expect(plan.aborted).toBe(false);
		const phaseOrder = [
			"trashLocal", "trashRemote", "mkdirRemote", "mkdirLocal",
			"renameLocal", "upload", "download", "trashRemoteDir", "trashLocalDir",
			"refreshBase", "dropBase",
		];
		const indices = plan.ops.map(op => phaseOrder.indexOf(op.kind));
		const sorted = [...indices].sort((a, b) => a - b);
		expect(indices).toEqual(sorted);
	});
});

describe("ignored folders (feature A)", () => {
	it("ignored remote-only folder is not downloaded", () => {
		const plan = planSync(
			localTree(), remoteTree(rf("private/secret.md", "u1")),
			new Map(), opts({ ignoredFolders: ["private"] }),
		);
		expect(plan.ops).toHaveLength(0);
	});

	it("ignored base-tracked file generates no ops and keeps its base record (no local delete propagation)", () => {
		// Local copy vanished, remote unchanged → would normally trashRemote.
		const plan = planSync(
			localTree(), remoteTree(rf("private/a.md", "u1")),
			new Map([["private/a.md", base(T0, 100, "u1")]]),
			opts({ ignoredFolders: ["private"] }),
		);
		expect(plan.ops).toHaveLength(0);
	});

	it("ignored history-only base record is NOT cleaned up while ignored", () => {
		const ignoredPlan = planSync(
			localTree(), remoteTree(),
			new Map([["private/gone.md", base()]]),
			opts({ ignoredFolders: ["private"] }),
		);
		expect(ignoredPlan.ops).toHaveLength(0); // no dropBase
		// Sanity: without the ignore, the same record is dropped.
		const normalPlan = planSync(
			localTree(), remoteTree(),
			new Map([["private/gone.md", base()]]),
			opts(),
		);
		expect(kinds(normalPlan.ops)).toContain("dropBase");
	});

	it("un-ignore (second run without the prefix) plans normally again", () => {
		const baseMap = new Map([["private/a.md", base(T0, 100, "u1")]]);
		const remote = remoteTree(rf("private/a.md", "u1"));
		// Run 1, ignored: local copy gone, nothing happens, base preserved.
		const run1 = planSync(localTree(), remote, baseMap, opts({ ignoredFolders: ["private"] }));
		expect(run1.ops).toHaveLength(0);
		// Run 2, un-ignored: the local deletion propagates from the intact base.
		const run2 = planSync(localTree(), remote, baseMap, opts());
		expect(kinds(run2.ops)).toContain("trashRemote");
	});

	it("ignored prefix does not match same-prefix siblings", () => {
		const plan = planSync(
			localTree(), remoteTree(rf("private-stuff/a.md", "u1")),
			new Map(), opts({ ignoredFolders: ["private"] }),
		);
		expect(kinds(plan.ops)).toContain("download");
	});
});

describe("rename detection (feature D)", () => {
	it("happy path: hash-matched local rename → renameRemote, no delete/upload", () => {
		const plan = planSync(
			localTree(lf("new.md")),
			remoteTree(rf("old.md", "u1", T0, 100, "hash-1")),
			new Map([["old.md", base(T0, 100, "u1")]]),
			opts({ localHashes: new Map([["new.md", "hash-1"]]) }),
		);
		expect(kinds(plan.ops)).toEqual(["renameRemote"]);
		const op = plan.ops[0];
		expect(op?.path).toBe("old.md");
		expect(op?.toPath).toBe("new.md");
		expect(op?.rename?.uuid).toBe("u1");
		expect(op?.rename?.fileKey).toBe("k");
		expect(op?.rename?.metadata.name).toBe("new.md");
		expect(op?.rename?.metadata.hash).toBe("hash-1");
		expect(op?.rename?.metadata.size).toBe(100);
		expect(plan.counts.renames).toBe(1);
	});

	it("ambiguity → skip: two identical targets fall back to delete + uploads", () => {
		const plan = planSync(
			localTree(lf("new1.md"), lf("new2.md")),
			remoteTree(rf("old.md", "u1", T0, 100, "hash-1")),
			new Map([["old.md", base(T0, 100, "u1")]]),
			opts({ localHashes: new Map([["new1.md", "hash-1"], ["new2.md", "hash-1"]]) }),
		);
		expect(kinds(plan.ops)).not.toContain("renameRemote");
		expect(kinds(plan.ops)).toContain("trashRemote");
		expect(kinds(plan.ops).filter(k => k === "upload")).toHaveLength(2);
	});

	it("ambiguity → skip: one target matched by two sources", () => {
		const plan = planSync(
			localTree(lf("new.md")),
			remoteTree(rf("old1.md", "u1", T0, 100, "hash-1"), rf("old2.md", "u2", T0, 100, "hash-1")),
			new Map([["old1.md", base(T0, 100, "u1")], ["old2.md", base(T0, 100, "u2")]]),
			opts({ localHashes: new Map([["new.md", "hash-1"]]) }),
		);
		expect(kinds(plan.ops)).not.toContain("renameRemote");
		expect(kinds(plan.ops).filter(k => k === "trashRemote")).toHaveLength(2);
		expect(kinds(plan.ops)).toContain("upload");
	});

	it("changed content (hash mismatch) → no rename, plain delete + upload", () => {
		const plan = planSync(
			localTree(lf("new.md")),
			remoteTree(rf("old.md", "u1", T0, 100, "hash-1")),
			new Map([["old.md", base(T0, 100, "u1")]]),
			opts({ localHashes: new Map([["new.md", "hash-other"]]) }),
		);
		expect(kinds(plan.ops)).not.toContain("renameRemote");
		expect(kinds(plan.ops)).toContain("trashRemote");
		expect(kinds(plan.ops)).toContain("upload");
	});

	it("changed remote (uuid differs from base) → no rename source", () => {
		const plan = planSync(
			localTree(lf("new.md")),
			remoteTree(rf("old.md", "u2", T0, 100, "hash-1")),
			new Map([["old.md", base(T0, 100, "u1")]]),
			opts({ localHashes: new Map([["new.md", "hash-1"]]) }),
		);
		expect(kinds(plan.ops)).not.toContain("renameRemote");
	});

	it("target busy (remote exists at target path) → no rename", () => {
		const plan = planSync(
			localTree(lf("new.md")),
			remoteTree(rf("old.md", "u1", T0, 100, "hash-1"), rf("new.md", "u2", T0, 100, "hash-1")),
			new Map([["old.md", base(T0, 100, "u1")]]),
			opts({ localHashes: new Map([["new.md", "hash-1"]]) }),
		);
		expect(kinds(plan.ops)).not.toContain("renameRemote");
	});

	it("rename ops are ordered BEFORE all deletes (execution phase 0)", () => {
		const plan = planSync(
			localTree(lf("new.md")),
			remoteTree(rf("old.md", "u1", T0, 100, "hash-1"), rf("gone.md", "u9", T0, 100, "hash-9")),
			new Map([
				["old.md", base(T0, 100, "u1")],
				["gone.md", base(T0, 100, "u9")],
			]),
			opts({ localHashes: new Map([["new.md", "hash-1"]]) }),
		);
		const renameIdx = plan.ops.findIndex(op => op.kind === "renameRemote");
		const deleteIdx = plan.ops.findIndex(op => op.kind === "trashRemote");
		expect(renameIdx).toBeGreaterThanOrEqual(0);
		expect(deleteIdx).toBeGreaterThan(renameIdx);
	});

	it("rename detection respects ignored folders", () => {
		const plan = planSync(
			localTree(lf("private/new.md")),
			remoteTree(rf("old.md", "u1", T0, 100, "hash-1")),
			new Map([["old.md", base(T0, 100, "u1")]]),
			opts({ localHashes: new Map([["private/new.md", "hash-1"]]), ignoredFolders: ["private"] }),
		);
		expect(kinds(plan.ops)).not.toContain("renameRemote");
	});
});

describe("config paths (v0.4.0 feature A)", () => {
	const CFG = ".obsidian";

	it("config conflict is ALWAYS keep-newer, never a conflict copy — local winner", () => {
		// Global policy keep_both; both sides changed since base; local newer.
		const local = localTree(lf(`${CFG}/appearance.json`, T0 + 5000, 120));
		const remote = remoteTree(rf(`${CFG}/appearance.json`, "u-cfg", T0 + 3000, 110));
		const baseMap = new Map([[`${CFG}/appearance.json`,
			base(T0, 100, "u-old", T0, 100)]]);
		const plan = planSync(local, remote, baseMap, opts({ configDir: CFG }));
		expect(plan.conflicts).toHaveLength(1);
		expect(plan.conflicts[0]?.policy).toBe("keep_newer");
		// keep-newer local-winner: upload with the remote loser trashed AFTER;
		// NO renameLocal and NO " (conflict " download.
		expect(kinds(plan.ops)).toEqual(["upload"]);
		expect(plan.ops[0]?.trashRemoteUuidAfter).toBe("u-cfg");
		expect(plan.ops.some(op => op.kind === "renameLocal")).toBe(false);
		expect(plan.ops.some(op => op.path.includes(" (conflict "))).toBe(false);
	});

	it("config conflict keep-newer — remote winner trashes local, downloads", () => {
		const local = localTree(lf(`${CFG}/hotkeys.json`, T0 + 1000, 120));
		const remote = remoteTree(rf(`${CFG}/hotkeys.json`, "u-cfg", T0 + 9000, 110));
		const baseMap = new Map([[`${CFG}/hotkeys.json`,
			base(T0, 100, "u-old", T0, 100)]]);
		const plan = planSync(local, remote, baseMap, opts({ configDir: CFG }));
		expect(plan.conflicts[0]?.policy).toBe("keep_newer");
		expect(plan.conflicts[0]?.winner).toBe("remote");
		expect(kinds(plan.ops).sort()).toEqual(["download", "trashLocal"]);
		expect(plan.ops.some(op => op.path.includes(" (conflict "))).toBe(false);
	});

	it("both-new config path (no base) still keep-newer, even in both-nonempty seed", () => {
		// Seed both-nonempty forces keep_both for regular paths — not for config.
		const local = localTree(
			lf("note.md", T0 + 5000),
			lf(`${CFG}/appearance.json`, T0 + 5000, 120),
		);
		const remote = remoteTree(
			rf("note.md", "u-note", T0 + 3000),
			rf(`${CFG}/appearance.json`, "u-cfg", T0 + 3000, 110),
		);
		const plan = planSync(local, remote, new Map(), opts({ configDir: CFG }));
		expect(plan.seedMode).toBe("both-nonempty");
		const noteConflict = plan.conflicts.find(c => c.path === "note.md");
		const cfgConflict = plan.conflicts.find(c => c.path === `${CFG}/appearance.json`);
		expect(noteConflict?.policy).toBe("keep_both");
		expect(cfgConflict?.policy).toBe("keep_newer");
		const cfgOps = plan.ops.filter(op => op.path.startsWith(CFG));
		expect(cfgOps.some(op => op.path.includes(" (conflict "))).toBe(false);
	});

	it("without configDir in options, config paths follow the global policy", () => {
		const local = localTree(lf(`${CFG}/appearance.json`, T0 + 5000, 120));
		const remote = remoteTree(rf(`${CFG}/appearance.json`, "u-cfg", T0 + 3000, 110));
		const plan = planSync(local, remote, new Map(), opts());
		expect(plan.conflicts[0]?.policy).toBe("keep_both");
	});
});

/* ---------------- v0.5.0: shared-preferences file exclusion ---------------- */

describe("planner never plans the shared-preferences file (v0.5.0)", () => {
	it("remote-only prefs file → no download, no ops at all", () => {
		const plan = planSync(
			localTree(),
			remoteTree(rf(".filen-sync-preferences.json", "u-prefs", T0, 200)),
			new Map(),
			opts({ ignoreMassChangeGuard: true }),
		);
		expect(plan.ops).toHaveLength(0);
		expect(plan.aborted).toBe(false);
	});

	it("prefs file on both sides → still no ops (never uploaded/trashed either)", () => {
		// A local file with the reserved name only reaches the planner if a
		// caller ignored the scan exclusion — the planner guard is the
		// second line of defense.
		const plan = planSync(
			localTree(lf(".filen-sync-preferences.json", T0 + 5000, 200)),
			remoteTree(rf(".filen-sync-preferences.json", "u-prefs", T0, 200)),
			new Map(),
			opts(),
		);
		expect(plan.ops).toHaveLength(0);
		expect(plan.conflicts).toHaveLength(0);
	});

	it("base-tracked prefs path → no trash, no dropBase", () => {
		const plan = planSync(
			localTree(),
			remoteTree(),
			new Map([[".filen-sync-preferences.json", base()]]),
			opts(),
		);
		expect(plan.ops).toHaveLength(0);
	});

	it("real files around the prefs file plan normally", () => {
		const plan = planSync(
			localTree(lf("note.md", T0)),
			remoteTree(rf(".filen-sync-preferences.json", "u-prefs", T0, 200)),
			new Map(),
			opts(),
		);
		expect(kinds(plan.ops)).toEqual(["upload"]);
		expect(plan.ops[0]?.path).toBe("note.md");
	});
});
