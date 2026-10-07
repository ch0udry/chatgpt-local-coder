import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [pkgRaw, verify, readme, agents, env, ui] = await Promise.all([
  readFile("package.json", "utf8"),
  readFile("scripts/verify-project-workspace.mjs", "utf8").catch(() => ""),
  readFile("README.md", "utf8"),
  readFile("AGENTS.md", "utf8"),
  readFile(".env.example", "utf8"),
  readFile("public/ui/index.html", "utf8"),
]);
const pkg = JSON.parse(pkgRaw);

assert.equal(pkg.scripts?.["test:pws"], "node scripts/verify-project-workspace.mjs");
for (const name of [
  "npm test",
  "test-project-registry.mjs",
  "test-project-registry-bootstrap.mjs",
  "test-session-project-state.mjs",
  "test-active-project-defaults.mjs",
  "test-project-instructions.mjs",
  "test-mcp-instructions.mjs",
  "test-skill-tools.mjs",
  "test-project-tools.mjs",
  "test-project-admin-api.mjs",
  "test-projects-ui.mjs",
  "test-project-editor-ui.mjs",
  "test-settings-ui.mjs",
  "test-admin-ui-language.mjs",
]) {
  assert.ok(verify.includes(name), `verification script missing ${name}`);
}
console.log("OK  dedicated PWS verification command covers required regression matrix");

for (const text of [readme, agents]) {
  assert.match(text, /profiles\/projects\.toml/);
  assert.match(text, /DEFAULT_SHELL_CWD/);
  assert.match(text, /list_projects/);
  assert.match(text, /use_project/);
  assert.match(text, /list_skills/);
  assert.match(text, /load_skill/);
  assert.match(text, /project-first|project skill.*global|project.*global fallback/is);
}
console.log("OK  README and AGENTS describe project/session/skill model");

assert.match(readme, /WORKSPACE_PATH.*legacy|legacy.*WORKSPACE_PATH/is);
assert.match(readme, /EXTRA_WORKSPACE_PATHS.*legacy|legacy.*EXTRA_WORKSPACE_PATHS/is);
assert.match(readme, /projects\.toml[\s\S]*missing[\s\S]*bootstrap|bootstrap[\s\S]*projects\.toml[\s\S]*missing/is);
assert.match(readme, /full machine access/i);
assert.match(readme, /Remove from ChatGPT Coder/);
console.log("OK  README documents non-destructive compatibility and unregister semantics");

assert.match(env, /DEFAULT_SHELL_CWD=/);
assert.match(env, /CHATGPT_GLOBAL_SKILLS_DIR=/);
assert.match(env, /profiles\/projects\.toml/);
assert.match(env, /legacy[\s\S]*bootstrap/i);
assert.match(env, /projects\.toml[\s\S]*missing|missing[\s\S]*projects\.toml/i);
console.log("OK  env example separates runtime settings from one-time project bootstrap");

assert.match(agents, /projects\.toml/);
assert.match(agents, /missing|không tồn tại/i);
console.log("OK  agent guidance treats TOML as persistent project source of truth");

assert.match(ui, /Machine \/ Shell/);
assert.match(ui, /These do not define project access boundaries/);
assert.match(ui, /Pinned skills are preferences only/);
console.log("OK  Admin help text reflects final boundaries");

console.log("\n6 passed, 0 failed");
