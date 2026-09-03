/**
 * v0.8.0 feature 2: the opt-in background-change notice — fires only when
 * enabled, non-manual, successful, and at least one transfer happened.
 */

import { describe, expect, it } from "vitest";
import { backgroundChangeNotice } from "../src/util";

const COUNTS = { uploads: 0, downloads: 0, trashLocal: 0, trashRemote: 0 };

describe("backgroundChangeNotice (v0.8.0 feature 2)", () => {
	it("composes from plan counts and pluralizes", () => {
		expect(backgroundChangeNotice({
			enabled: true, manual: false, status: "ok",
			counts: { ...COUNTS, downloads: 2 },
		})).toBe("2 files updated from the cloud");
		expect(backgroundChangeNotice({
			enabled: true, manual: false, status: "ok",
			counts: { ...COUNTS, uploads: 1 },
		})).toBe("1 file uploaded");
		expect(backgroundChangeNotice({
			enabled: true, manual: false, status: "ok",
			counts: { uploads: 1, downloads: 2, trashLocal: 1, trashRemote: 1 },
		})).toBe("1 file uploaded, 2 files updated from the cloud, 2 files deleted");
	});

	it("is silent when disabled", () => {
		expect(backgroundChangeNotice({
			enabled: false, manual: false, status: "ok",
			counts: { ...COUNTS, downloads: 3 },
		})).toBeNull();
	});

	it("is silent on manual runs (progress modal already covers those)", () => {
		expect(backgroundChangeNotice({
			enabled: true, manual: true, status: "ok",
			counts: { ...COUNTS, downloads: 3 },
		})).toBeNull();
	});

	it("is silent on empty runs (nothing transferred)", () => {
		expect(backgroundChangeNotice({
			enabled: true, manual: false, status: "empty",
			counts: COUNTS,
		})).toBeNull();
		expect(backgroundChangeNotice({
			enabled: true, manual: false, status: "ok",
			counts: COUNTS,
		})).toBeNull();
	});

	it("is silent on error runs (existing error notice behavior is unchanged)", () => {
		expect(backgroundChangeNotice({
			enabled: true, manual: false, status: "error",
			counts: { ...COUNTS, uploads: 2 },
		})).toBeNull();
	});
});
