// Generates a project that imports N trivial node_modules packages.
// The bug is a function of how many resolved modules the program watches, so
// the repro just needs enough distinct node_modules imports to cross the limit.
//
//   node setup.mjs 600   -> over the limit, `tsc -b --watch` goes deaf
//   node setup.mjs 400   -> under the limit, watch works
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const count = Number(process.argv[2] ?? 600);

const scope = path.join(root, "node_modules");
for (const e of fs.readdirSync(scope)) {
  if (/^dep\d+$/.test(e)) fs.rmSync(path.join(scope, e), { recursive: true, force: true });
}
fs.rmSync(path.join(root, "src"), { recursive: true, force: true });
fs.mkdirSync(path.join(root, "src"), { recursive: true });

let imports = "";
const names = [];
for (let i = 0; i < count; i++) {
  const dir = path.join(scope, "dep" + i);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"),
    JSON.stringify({ name: "dep" + i, version: "1.0.0", types: "index.d.ts" }));
  fs.writeFileSync(path.join(dir, "index.d.ts"), `export declare const d${i}: number;\n`);
  imports += `import { d${i} } from "dep${i}";\n`;
  names.push("d" + i);
}
fs.writeFileSync(path.join(root, "src", "index.ts"),
  imports + `export const marker: number = 1;\nexport const sum = ${names.join(" + ") || "0"};\n`);

console.log(`Generated src/index.ts importing ${count} node_modules packages.`);
