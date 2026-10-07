import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const { loadProjectRegistry, ProjectRuntimeState } = await import("../dist/lib/project-registry.js");

const root = await mkdtemp(path.join(tmpdir(), "pws023-"));
const profiles = path.join(root, "profiles");
const registryPath = path.join(profiles, "projects.toml");
await mkdir(profiles, { recursive: true });

const original = `version = 1
primary_project = "chmfhm"
default_project_instruction = ""

[[projects]]
id = "chmfhm"
name = "chmfhm"
path = "/home/chmfhm"
use_default_instruction = true
instruction = ""
pinned_skills = []

[[projects]]
id = "chatgpt-local-coder"
name = "chatgpt-local-coder"
path = "/home/chmfhm/docker/compose/chatgpt-local-coder"
use_default_instruction = true
instruction = ""
pinned_skills = []
`;
await writeFile(registryPath, original, "utf8");

const migrated = await loadProjectRegistry(registryPath);
assert.equal(migrated.version, 2);
assert.equal(migrated.active_project, "chmfhm");
assert.deepEqual(
  migrated.projects.map((p) => p.id),
  ["chmfhm", "chatgpt-local-coder"]
);
assert.equal(await readFile(registryPath + ".v1.bak", "utf8"), original);
console.log("OK  exact production v1 migrates to v2 with rollback backup");

const runtime = new ProjectRuntimeState(migrated, "/home/chmfhm", registryPath);
const next = runtime.getRegistry();
next.projects = next.projects.filter((project) =>
  !(project.id === "chmfhm" && path.resolve(project.path) === "/home/chmfhm")
);
if (next.active_project === "chmfhm") delete next.active_project;
const final = await runtime.replaceRegistry(next);

assert.equal(final.registry.version, 2);
assert.equal(final.mode, "shell");
assert.equal(final.activeProject, null);
assert.equal(final.effectiveRoot, "/home/chmfhm");
assert.deepEqual(final.registry.projects.map((p) => p.id), ["chatgpt-local-coder"]);

const raw = await readFile(registryPath, "utf8");
assert.match(raw, /^version = 2/m);
assert.doesNotMatch(raw, /primary_project/);
assert.doesNotMatch(raw, /active_project/);
assert.doesNotMatch(raw, /id = "chmfhm"/);
assert.match(raw, /id = "chatgpt-local-coder"/);
assert.equal(await readFile(registryPath + ".v1.bak", "utf8"), original);
console.log("OK  pseudo-project cleanup leaves intentional Shell Mode and real project only");

const restarted = await loadProjectRegistry(registryPath);
assert.equal(restarted.version, 2);
assert.equal(restarted.active_project, undefined);
assert.equal(restarted.projects.length, 1);
assert.equal(restarted.projects[0].id, "chatgpt-local-coder");
console.log("OK  final production state survives reload without fallback");

console.log("\n3 passed, 0 failed");
