import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "pws020-shell-"));
const registryPath = path.join(root, "profiles", "projects.toml");
const projectA = path.join(root, "project-a");
await mkdir(projectA, { recursive: true });

const [{ createAdminRouter }, { ProjectRuntimeState, saveProjectRegistry }] = await Promise.all([
  import("../dist/admin/routes.js"),
  import("../dist/lib/project-registry.js"),
]);
const registry = {
  version: 2,
  active_project: "a",
  default_project_instruction: "",
  projects: [{ id: "a", name: "A", path: projectA, use_default_instruction: true, instruction: "", pinned_skills: [] }],
};
await saveProjectRegistry(registry, registryPath);
const runtime = new ProjectRuntimeState(registry, root, registryPath);
const manager = {
  listStatuses: async () => [],
  getConfig: () => ({ version: 1, servers: [] }),
  getConfigPath: () => path.join(root, "mcp-upstream.json"),
};
const app = express();
app.use(express.json());
app.use(createAdminRouter(manager, {
  mcpPort: 3333,
  pid: process.pid,
  sessionCount: () => 0,
  projectRuntime: runtime,
}));
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("listen failed");
const base = `http://127.0.0.1:${address.port}`;

try {
  const response = await fetch(base + "/api/projects/shell", { method: "PUT" });
  const json = await response.json();
  assert.equal(response.status, 200);
  assert.equal(json.mode, "shell");
  assert.equal(json.active_project_id, null);
  assert.equal(json.effective_root, root);
  assert.equal(runtime.getActiveProject(), null);
  console.log("OK  Admin Shell Mode clears global active project");
  console.log("\n1 passed, 0 failed");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
