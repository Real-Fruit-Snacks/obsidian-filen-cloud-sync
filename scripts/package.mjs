/**
 * Package the plugin: copy main.js + manifest.json + styles.css into
 * dist/filen-cloud-sync/ and zip as dist/filen-cloud-sync-<version>.zip.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const outDir = join("dist", manifest.id);

rmSync("dist", { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const file of ["main.js", "manifest.json", "styles.css"]) {
	copyFileSync(file, join(outDir, file));
}

execFileSync(
	"zip",
	["-r", `${manifest.id}-${manifest.version}.zip`, manifest.id],
	{ cwd: "dist" },
);

console.log(`packaged dist/${manifest.id}-${manifest.version}.zip`);
