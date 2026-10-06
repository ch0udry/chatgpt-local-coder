import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const html = await readFile(path.join("public", "ui", "index.html"), "utf8");
const js = await readFile(path.join("public", "ui", "app.js"), "utf8");
const settingsHtml = html.match(/<section id="settings"[\s\S]*?<\/section>/)?.[0] ?? "";

assert.match(html, /id="settings-machine"/);
assert.match(html, /Machine\s*\/\s*Shell/i);
assert.match(html, /id="settings-global-context"/);
assert.match(html, /Global Context/i);
assert.match(html, /id="settings-runtime"/);
assert.match(html, /Runtime/i);
console.log("OK  Settings is grouped into Machine/Shell, Global Context and Runtime");

assert.match(html, /id="default-project-instruction"/);
assert.match(html, /restart required/i);
assert.doesNotMatch(settingsHtml, /Project Path/i);
assert.doesNotMatch(settingsHtml, /Extra Workspace Paths/i);
console.log("OK  default project instruction is editable and legacy project-path UX is absent");

assert.match(js, /DEFAULT_SHELL_CWD/);
assert.match(js, /SHELL_TIMEOUT/);
assert.match(js, /CHATGPT_GLOBAL_SKILLS_DIR/);
assert.match(js, /CHATGPT_TOOL_PROFILE/);
assert.match(js, /CHECKPOINT_ENABLED/);
assert.match(js, /MCP_UPSTREAM_CONFIG/);
assert.match(js, /POST_EDIT_HOOKS_CONFIG/);
assert.doesNotMatch(js.match(/const ENV_KEYS\s*=\s*\[[\s\S]*?\];/)?.[0] ?? "", /WORKSPACE_PATH/);
assert.doesNotMatch(js.match(/const ENV_KEYS\s*=\s*\[[\s\S]*?\];/)?.[0] ?? "", /EXTRA_WORKSPACE_PATHS/);
console.log("OK  Settings env surface contains supported global/runtime keys only");

assert.match(js, /api\("\/api\/config\/env"\)/);
assert.match(js, /api\("\/api\/projects\/config"\)/);
assert.match(js, /api\("\/api\/config\/env",\s*\{\s*method:\s*"PUT"/);
assert.match(js, /api\("\/api\/projects\/config",\s*\{\s*method:\s*"PUT"/);
console.log("OK  Settings loads and saves env plus project-registry config through existing APIs");

console.log("\n4 passed, 0 failed");
