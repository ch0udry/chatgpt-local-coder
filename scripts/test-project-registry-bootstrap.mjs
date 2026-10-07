import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const mod = await import("../dist/lib/project-registry.js");
assert.equal(
  typeof mod.loadOrBootstrapProjectRegistry,
  "function",
  "loadOrBootstrapProjectRegistry must exist"
);

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pws014-registry-"));
  return {
    root,
    file: path.join(root, "profiles", "projects.toml"),
    a: path.join(root, "project-a"),
    b: path.join(root, "project-b"),
  };
}

{
  const f = await fixture();
  const registry = await mod.loadOrBootstrapProjectRegistry(
    { WORKSPACE_PATH: f.a, EXTRA_WORKSPACE_PATHS: f.b },
    f.file
  );
  assert.deepEqual(registry.projects.map((p) => p.path), [f.a, f.b]);
  await access(f.file);
  const raw = await readFile(f.file, "utf8");
  assert.match(raw, /\[\[projects\]\]/);
  console.log("OK  missing TOML bootstraps legacy env and persists TOML");

  const second = await mod.loadOrBootstrapProjectRegistry(
    { WORKSPACE_PATH: "/different", EXTRA_WORKSPACE_PATHS: "/also-different" },
    f.file
  );
  assert.deepEqual(second.projects.map((p) => p.path), [f.a, f.b]);
  console.log("OK  persisted TOML wins over later legacy env changes");
}

{
  const f = await fixture();
  await mod.saveProjectRegistry(mod.defaultProjectRegistry(), f.file);
  const registry = await mod.loadOrBootstrapProjectRegistry(
    { WORKSPACE_PATH: f.a, EXTRA_WORKSPACE_PATHS: f.b },
    f.file
  );
  assert.deepEqual(registry.projects, []);
  console.log("OK  existing empty TOML remains authoritative");
}

{
  const f = await fixture();
  const registry = await mod.loadOrBootstrapProjectRegistry({}, f.file);
  assert.deepEqual(registry.projects, []);
  let exists = true;
  try {
    await access(f.file);
  } catch {
    exists = false;
  }
  assert.equal(exists, false);
  console.log("OK  missing TOML without legacy env remains shell-only");
}

console.log("\n4 passed, 0 failed");
