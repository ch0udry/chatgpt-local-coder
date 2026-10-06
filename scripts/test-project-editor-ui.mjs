import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const html = await readFile(path.join("public", "ui", "index.html"), "utf8");
const js = await readFile(path.join("public", "ui", "app.js"), "utf8");
const css = await readFile(path.join("public", "ui", "styles.css"), "utf8");

assert.match(html, /id="project-edit-dialog"/);
assert.match(html, /id="project-edit-form"/);
assert.match(html, /name="name"/);
assert.match(html, /name="path"[^>]*readonly|readonly[^>]*name="path"/);
assert.match(html, /name="use_default_instruction"/);
assert.match(html, /name="instruction"/);
console.log("OK  focused editor has required project/instruction fields");

assert.match(html, /id="project-context-summary"/);
assert.match(html, /id="project-skills-list"/);
assert.match(html, /id="global-skills-list"/);
assert.match(html, /id="browse-project-skills"/);
console.log("OK  context and project/global skill surfaces exist");

assert.match(js, /\/api\/projects\/\$\{id\}\/skills/);
assert.match(js, /\/api\/projects\/\$\{id\}\/inspect/);
assert.match(js, /method:\s*"PUT"/);
assert.match(js, /pinned_skills/);
assert.match(js, /skill-source project/);
assert.match(js, /skill-source global/);
console.log("OK  editor loads sources and persists pinned preferences");

assert.match(js, /data-project-action="edit"/);
assert.doesNotMatch(js, /filter\([^\n]*pinned_skills[^\n]*\)/);
assert.match(html, /Pinned skills are preferences only/i);
console.log("OK  pinned skills remain preference-only and card opens editor");

assert.match(css, /\.skill-source\.project/);
assert.match(css, /\.skill-source\.global/);
console.log("OK  project/global skill sources are visually distinct");

console.log("\n5 passed, 0 failed");
