import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildInstructionContext } from "../dist/lib/instruction-context.js";

const root = await mkdtemp(path.join(tmpdir(), "pws004-"));
const a = path.join(root, "a");
const b = path.join(root, "b");
await mkdir(path.join(a, ".claude", "skills", "demo"), { recursive: true });
await mkdir(path.join(b, ".claude", "skills", "demo"), { recursive: true });

const agentA = "# A AGENT\nA-REPO-MARKER";
const agentB = "# B AGENT\nB-REPO-MARKER";
await writeFile(path.join(a, "AGENTS.md"), agentA, "utf8");
await writeFile(path.join(b, "AGENTS.md"), agentB, "utf8");
await writeFile(path.join(a, ".claude", "skills", "demo", "SKILL.md"), "---\nname: demo-a\ndescription: A skill marker\n---\n", "utf8");
await writeFile(path.join(b, ".claude", "skills", "demo", "SKILL.md"), "---\nname: demo-b\ndescription: B skill marker\n---\n", "utf8");

const common = {
  workspaceRoots: [a, b],
  pid: process.pid,
  adminPort: 3331,
  defaultProjectInstruction: "DEFAULT-PROJECT-MARKER",
};

const ctxA = await buildInstructionContext({
  ...common,
  workspaceRoot: a,
  useDefaultProjectInstruction: true,
  projectInstruction: "PROJECT-A-CUSTOM",
});

const ctxB = await buildInstructionContext({
  ...common,
  workspaceRoot: b,
  useDefaultProjectInstruction: false,
  projectInstruction: "PROJECT-B-CUSTOM",
});

assert.match(ctxA.instructionsText, /Agent workflow/);
assert.match(ctxB.instructionsText, /Agent workflow/);
assert.match(ctxA.instructionsText, /DEFAULT-PROJECT-MARKER/);
assert.doesNotMatch(ctxB.instructionsText, /DEFAULT-PROJECT-MARKER/);
assert.match(ctxA.instructionsText, /PROJECT-A-CUSTOM/);
assert.doesNotMatch(ctxA.instructionsText, /PROJECT-B-CUSTOM/);
assert.match(ctxB.instructionsText, /PROJECT-B-CUSTOM/);
assert.doesNotMatch(ctxB.instructionsText, /PROJECT-A-CUSTOM/);
assert.match(ctxA.instructionsText, /A-REPO-MARKER/);
assert.doesNotMatch(ctxA.instructionsText, /B-REPO-MARKER/);
assert.match(ctxB.instructionsText, /B-REPO-MARKER/);
assert.doesNotMatch(ctxB.instructionsText, /A-REPO-MARKER/);

const aDefault = ctxA.instructionsText.indexOf("DEFAULT-PROJECT-MARKER");
const aCustom = ctxA.instructionsText.indexOf("PROJECT-A-CUSTOM");
const aRepo = ctxA.instructionsText.indexOf("A-REPO-MARKER");
const aSkill = ctxA.instructionsText.indexOf("A skill marker");
assert.ok(aDefault >= 0 && aDefault < aCustom);
assert.ok(aCustom < aRepo);
assert.ok(aRepo < aSkill);

assert.equal(await readFile(path.join(a, "AGENTS.md"), "utf8"), agentA);
assert.equal(await readFile(path.join(b, "AGENTS.md"), "utf8"), agentB);

console.log("OK  global instruction shared");
console.log("OK  default project instruction obeys per-project toggle");
console.log("OK  custom project instructions are isolated");
console.log("OK  repo-native instructions and skill metadata keep composition order");
console.log("OK  composition does not modify repo instruction files");
console.log("\n5 passed, 0 failed");
