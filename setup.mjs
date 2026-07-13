// Generates a `tsc -b` solution that reproduces the slow computeDesiredWatches
// stall: N composite projects, each importing K shared node_modules packages.
//
// The bug scales with (total input+buildinfo files) x (number of desired watch
// dirs), so it needs a multi-project solution with many resolved modules to
// show up. Defaults (N=15, K=1500) put computeDesiredWatches at ~85s on an M-series
// Mac; a single small project returns in milliseconds and hides the bug.
//
//   node setup.mjs          # N=15 K=1500
//   node setup.mjs 15 1500
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const N = Number(process.argv[2] ?? 15);
const K = Number(process.argv[3] ?? 1500);

const nm = path.join(root, "node_modules");
for (const e of fs.readdirSync(nm)) {
  if (/^dep\d+$/.test(e)) fs.rmSync(path.join(nm, e), { recursive: true, force: true });
}
fs.rmSync(path.join(root, "projects"), { recursive: true, force: true });

// K shared node_modules packages (each a package.json + a .d.ts).
let imports = "";
const names = [];
for (let i = 0; i < K; i++) {
  const d = path.join(nm, "dep" + i);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "package.json"),
    JSON.stringify({ name: "dep" + i, version: "1.0.0", types: "index.d.ts" }));
  fs.writeFileSync(path.join(d, "index.d.ts"), `export declare const d${i}: number;\n`);
  imports += `import { d${i} } from "dep${i}";\n`;
  names.push("d" + i);
}
const body = imports + `export const sum = ${names.join(" + ") || "0"};\n`;

// N composite projects, each importing all K packages.
const references = [];
for (let p = 0; p < N; p++) {
  const dir = path.join(root, "projects", "p" + p);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.ts"), `export const marker${p}: number = 1;\n` + body);
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { composite: true, outDir: "dist", rootDir: "src", moduleResolution: "bundler", module: "esnext" },
    include: ["src/**/*.ts"],
  }, null, 2));
  references.push({ path: `./projects/p${p}` });
}
fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ files: [], references }, null, 2));

console.log(`Generated a solution: ${N} projects x ${K} shared node_modules packages.`);
