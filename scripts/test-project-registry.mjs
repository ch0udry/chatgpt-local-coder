import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bootstrapLegacyProjects,
  defaultProjectRegistry,
  loadProjectRegistry,
  resolvePrimaryProject,
  saveProjectRegistry,
  validateProjectRegistry,
} from "../dist/lib/project-registry.js";

let passed = 0;

function ok(name) {
  console.log(`OK  ${name}`);
  passed++;
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pws-registry-"));
  const a = path.join(root, "project-a");
  const b = path.join(root, "project-b");
  await mkdir(a);
  await mkdir(b);
  return { a, b, file: path.join(root, "projects.toml") };
}

{
  assert.deepEqual(defaultProjectRegistry(), {
    version: 1,
    default_project_instruction: "",
    projects: [],
  });
  ok("default registry");
}

{
  const f = await fixture();
  const registry = {
    version: 1,
    primary_project: "b",
    default_project_instruction: "Verify source.\nPrefer minimal changes.",
    projects: [
      {
        id: "a",
        name: "Project A",
        path: f.a,
        use_default_instruction: true,
        instruction: "A rules",
        pinned_skills: ["graphify-query"],
      },
      {
        id: "b",
        name: "Project B",
        path: f.b,
        use_default_instruction: false,
        instruction: "B only\nSecond line",
        pinned_skills: [],
      },
    ],
  };

  await saveProjectRegistry(registry, f.file);
  assert.deepEqual(await loadProjectRegistry(f.file), registry);

  const raw = await readFile(f.file, "utf8");
  assert.match(raw, /^version = 1/m);
  assert.match(raw, /primary_project = "b"/);
  assert.match(raw, /default_project_instruction/);
  assert.match(raw, /\[\[projects\]\]/);
  assert.match(raw, /use_default_instruction = false/);
  ok("TOML registry round-trip");
}

{
  const f = await fixture();
  assert.throws(
    () =>
      validateProjectRegistry({
        version: 1,
        default_project_instruction: "",
        projects: [
          { id: "same", name: "A", path: f.a, use_default_instruction: true, instruction: "", pinned_skills: [] },
          { id: "same", name: "B", path: f.b, use_default_instruction: true, instruction: "", pinned_skills: [] },
        ],
      }),
    /duplicate project id/i
  );
  ok("duplicate id rejected");
}

{
  const f = await fixture();
  assert.throws(
    () =>
      validateProjectRegistry({
        version: 1,
        default_project_instruction: "",
        projects: [
          { id: "a", name: "A", path: f.a, use_default_instruction: true, instruction: "", pinned_skills: [] },
          { id: "b", name: "B", path: path.join(f.a, "."), use_default_instruction: true, instruction: "", pinned_skills: [] },
        ],
      }),
    /duplicate project path/i
  );
  ok("duplicate path rejected");
}

{
  const f = await fixture();
  assert.deepEqual(await loadProjectRegistry(f.file), {
    version: 1,
    default_project_instruction: "",
    projects: [],
  });
  ok("missing registry returns empty registry");
}

{
  const f = await fixture();
  const base = {
    version: 1,
    default_project_instruction: "",
    projects: [
      { id: "a", name: "A", path: f.a, use_default_instruction: true, instruction: "", pinned_skills: [] },
      { id: "b", name: "B", path: f.b, use_default_instruction: true, instruction: "", pinned_skills: [] },
    ],
  };
  assert.equal(resolvePrimaryProject({ ...base, primary_project: "b" })?.id, "b");
  assert.equal(resolvePrimaryProject({ ...base, primary_project: "missing" })?.id, "a");
  assert.equal(resolvePrimaryProject({ version: 1, default_project_instruction: "", projects: [] }), null);
  ok("primary resolution is deterministic");
}

{
  const f = await fixture();
  const raw = `version = 1
default_project_instruction = ""

[[projects]]
id = "a"
name = "A"
path = "${f.a.replaceAll("\\", "\\\\")}"
instruction = ""
pinned_skills = []
`;
  await writeFile(f.file, raw, "utf8");
  const loaded = await loadProjectRegistry(f.file);
  assert.equal(loaded.projects[0].use_default_instruction, true);
  ok("missing use_default_instruction defaults true");
}

{
  const f = await fixture();
  const registry = bootstrapLegacyProjects({
    WORKSPACE_PATH: f.a,
    EXTRA_WORKSPACE_PATHS: `${f.b};${f.a}`,
  });
  assert.deepEqual(registry.projects.map((project) => project.path), [f.a, f.b]);
  assert.equal(registry.primary_project, registry.projects[0].id);
  assert.ok(registry.projects.every((project) => project.use_default_instruction));
  ok("legacy workspace paths bootstrap uniquely");
}

console.log(`\n${passed} passed, 0 failed`);
