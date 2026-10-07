import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const mod = await import("../dist/lib/project-registry.js");

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pws016-"));
  const a = path.join(root, "project-a");
  const b = path.join(root, "project-b");
  await mkdir(a);
  await mkdir(b);
  return { root, a, b, file: path.join(root, "profiles", "projects.toml") };
}

function project(id, projectPath) {
  return {
    id,
    name: id.toUpperCase(),
    path: projectPath,
    use_default_instruction: true,
    instruction: "",
    pinned_skills: [],
  };
}

{
  assert.deepEqual(mod.defaultProjectRegistry(), {
    version: 2,
    default_project_instruction: "",
    projects: [],
  });
  console.log("OK  v2 default registry is Shell Mode");
}

{
  const f = await fixture();
  const registry = {
    version: 2,
    active_project: "b",
    default_project_instruction: "verify",
    projects: [project("a", f.a), project("b", f.b)],
  };
  await mod.saveProjectRegistry(registry, f.file);
  assert.deepEqual(await mod.loadProjectRegistry(f.file), registry);
  assert.equal(mod.resolveActiveProject(registry)?.id, "b");
  const raw = await readFile(f.file, "utf8");
  assert.match(raw, /^version = 2/m);
  assert.match(raw, /active_project = "b"/);
  assert.doesNotMatch(raw, /primary_project/);
  console.log("OK  v2 active project round-trips");
}

{
  const f = await fixture();
  assert.throws(
    () => mod.validateProjectRegistry({
      version: 2,
      active_project: "missing",
      default_project_instruction: "",
      projects: [project("a", f.a)],
    }),
    /active project.*not registered/i
  );
  console.log("OK  invalid v2 active project is rejected");
}

{
  const f = await fixture();
  const registry = await mod.loadOrBootstrapProjectRegistry(
    { WORKSPACE_PATH: f.a, EXTRA_WORKSPACE_PATHS: f.b },
    f.file
  );
  assert.equal(registry.version, 2);
  assert.equal(registry.active_project, undefined);
  assert.deepEqual(registry.projects, []);
  let exists = true;
  try { await access(f.file); } catch { exists = false; }
  assert.equal(exists, false);
  console.log("OK  missing TOML ignores legacy project env and stays Shell Mode");
}

{
  const f = await fixture();
  await mkdir(path.dirname(f.file), { recursive: true });
  const v1 = {
    version: 1,
    primary_project: "b",
    default_project_instruction: "legacy",
    projects: [project("a", f.a), project("b", f.b)],
  };
  await writeFile(f.file, [
    "version = 1",
    'primary_project = "b"',
    'default_project_instruction = "legacy"',
    "",
    ...v1.projects.flatMap((p) => [
      "[[projects]]",
      `id = "${p.id}"`,
      `name = "${p.name}"`,
      `path = "${p.path.replaceAll("\\", "\\\\")}"`,
      "use_default_instruction = true",
      'instruction = ""',
      "pinned_skills = []",
      "",
    ]),
  ].join("\n"), "utf8");

  const migrated = await mod.loadProjectRegistry(f.file);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.active_project, "b");
  assert.equal(migrated.projects.length, 2);
  await access(f.file + ".v1.bak");
  const raw = await readFile(f.file, "utf8");
  assert.match(raw, /^version = 2/m);
  assert.doesNotMatch(raw, /primary_project/);
  console.log("OK  v1 primary migrates to v2 active with one backup");
}

{
  const f = await fixture();
  await mkdir(path.dirname(f.file), { recursive: true });
  await writeFile(f.file, `version = 1
primary_project = "missing"
default_project_instruction = ""

[[projects]]
id = "a"
name = "A"
path = "${f.a}"
use_default_instruction = true
instruction = ""
pinned_skills = []
`, "utf8");
  const migrated = await mod.loadProjectRegistry(f.file);
  assert.equal(migrated.active_project, undefined);
  assert.equal(mod.resolveActiveProject(migrated), null);
  console.log("OK  invalid v1 primary migrates to Shell Mode without fallback");
}

{
  const f = await fixture();
  const initial = {
    version: 2,
    active_project: "a",
    default_project_instruction: "",
    projects: [project("a", f.a), project("b", f.b)],
  };
  await mod.saveProjectRegistry(initial, f.file);
  const runtime = new mod.ProjectRuntimeState(initial, f.root, f.file);
  assert.equal(runtime.getMode(), "project");
  assert.equal(runtime.getEffectiveRoot(), f.a);
  const rev = runtime.getRuntimeRevision();
  await runtime.activateProject("b");
  assert.equal(runtime.getActiveProject()?.id, "b");
  assert.equal(runtime.getEffectiveRoot(), f.b);
  assert.equal(runtime.getRuntimeRevision(), rev + 1);
  await runtime.useShellMode();
  assert.equal(runtime.getMode(), "shell");
  assert.equal(runtime.getActiveProject(), null);
  assert.equal(runtime.getEffectiveRoot(), path.resolve(f.root));
  console.log("OK  shared runtime publishes active project and Shell Mode");
}

{
  const f = await fixture();
  const initial = {
    version: 2,
    active_project: "a",
    default_project_instruction: "",
    projects: [project("a", f.a), project("b", f.b)],
  };
  const runtime = new mod.ProjectRuntimeState(initial, f.root, path.join(f.root, "not-a-dir", "projects.toml"));
  await writeFile(path.join(f.root, "not-a-dir"), "file", "utf8");
  await assert.rejects(() => runtime.activateProject("b"));
  assert.equal(runtime.getActiveProject()?.id, "a");
  console.log("OK  failed persistence does not publish runtime state");
}

console.log("\n8 passed, 0 failed");
