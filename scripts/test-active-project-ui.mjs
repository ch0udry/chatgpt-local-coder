import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const html = await readFile(path.join("public", "ui", "index.html"), "utf8");
const js = await readFile(path.join("public", "ui", "app.js"), "utf8");

assert.match(html, /id="use-shell-mode"/);
assert.match(html, />Use Shell Mode</);
assert.match(js, /data-project-action="activate"/);
assert.match(js, />Active</);
assert.match(js, /\/api\/projects\/\$\{id\}\/activate/);
assert.match(js, /\/api\/projects\/shell/);
assert.doesNotMatch(js, /Set Primary|Primary project updated|data-project-action="primary"/);
assert.doesNotMatch(html, />Primary</);
console.log("OK  Projects UI exposes Active / Activate / Shell Mode without Primary semantics");
console.log("\n1 passed, 0 failed");
