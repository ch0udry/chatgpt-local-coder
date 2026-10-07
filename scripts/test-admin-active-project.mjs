import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "pws020-"));
const registryPath = path.join(root, "profiles", "projects.toml");
const projectA = path.join(root, "project-a");
await mkdir(projectA, { recursive: true });

const [{ createAdminRouter }, { ProjectRuntimeState, saveProjectRegistry }] = await Promise.all([
  import("../dist/admin/routes.js"),
  import("../dist/lib/project-registry.js"),
]);

const registry = {
  version: 2,
  default_project_instruction: "",
  projects: [{
    id: "a",
    name: "Project A",
    path: projectA,
    use_default_instruction: true,
    instruction: "",
    pinned_skills: [],
  }],
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

async function request(method, url, body) {
  const response = await fetch(base + url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

try {
  const result = await request("PUT", "/api/projects/a/activate");
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.mode, "project");
  assert.equal(result.json.active_project_id, "a");
  assert.equal(result.json.effective_root, projectA);
  assert.equal(result.json.runtime_revision, 2);
  assert.equal(runtime.getActiveProject()?.id, "a");
  console.log("OK  Admin activation publishes Project A through shared runtime");
  console.log("\n1 passed, 0 failed");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
