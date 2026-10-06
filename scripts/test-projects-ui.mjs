import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const html = await readFile(path.join("public", "ui", "index.html"), "utf8");
const js = await readFile(path.join("public", "ui", "app.js"), "utf8");
const css = await readFile(path.join("public", "ui", "styles.css"), "utf8");

assert.match(html, /data-tab="project">Projects</);
assert.match(html, /id="projects-grid"/);
assert.match(html, /id="add-project"/);
assert.match(html, /id="project-add-dialog"/);
assert.match(html, /name="path"/);
assert.match(html, /name="name"/);
console.log("OK  Projects navigation/list/add dialog structure exists");

assert.match(js, /api\("\/api\/projects"\)/);
assert.match(js, /data-project-action="(?:open|edit)"/);
assert.match(js, /data-project-action="primary"/);
assert.match(js, /data-project-action="remove"/);
assert.match(js, /Remove from ChatGPT Coder/);
assert.match(js, /files and folders on disk will not be deleted/i);
console.log("OK  project cards expose required actions and safe remove wording");

assert.doesNotMatch(html, /id="project-preview"/);
assert.doesNotMatch(html, /id="project-meta"/);
assert.doesNotMatch(html, /WORKSPACE_PATHS/);
assert.doesNotMatch(html, /EXTRA_WORKSPACE_PATHS/);
console.log("OK  Projects page is not the old single-root/raw-path UI");

assert.match(css, /\.project-grid/);
assert.match(css, /repeat\(auto-fill,\s*minmax\(/);
assert.match(css, /\.project-card/);
console.log("OK  project card layout is responsive for larger project lists");

console.log("\n4 passed, 0 failed");
