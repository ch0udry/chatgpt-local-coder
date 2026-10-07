import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "pws020-life-"));
const registryPath = path.join(root, "profiles", "projects.toml");
const projectA = path.join(root, "project-a");
const projectB = path.join(root, "project-b");
await mkdir(projectA, { recursive: true });
await mkdir(projectB, { recursive: true });

const [{ createAdminRouter }, { ProjectRuntimeState, defaultProjectRegistry }] = await Promise.all([
  import("../dist/admin/routes.js"),
  import("../dist/lib/project-registry.js"),
]);
const runtime = new ProjectRuntimeState(defaultProjectRegistry(), root, registryPath);
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
  return { status: response.status, json: await response.json() };
}

try {
  let r = await request("POST", "/api/projects", { name: "A", path: projectA });
  assert.equal(r.status, 200);
  const a = r.json.project.id;
  assert.equal(r.json.active_project_id, null);
  assert.equal(runtime.getMode(), "shell");

  r = await request("POST", "/api/projects", { name: "B", path: projectB });
  const b = r.json.project.id;
  assert.equal(runtime.getMode(), "shell");
  console.log("OK  Add Project registers only and does not activate");

  r = await request("PUT", `/api/projects/${a}/activate`);
  assert.equal(r.json.active_project_id, a);

  r = await request("DELETE", `/api/projects/${b}`);
  assert.equal(r.json.active_project_id, a);
  assert.equal(runtime.getActiveProject()?.id, a);
  console.log("OK  deleting inactive project preserves active project");

  r = await request("DELETE", `/api/projects/${a}`);
  assert.equal(r.json.mode, "shell");
  assert.equal(r.json.active_project_id, null);
  assert.equal(runtime.getActiveProject(), null);
  console.log("OK  deleting active project enters Shell Mode");

  r = await request("GET", "/health");
  assert.equal(r.json.mode, "shell");
  assert.equal(r.json.active_project_id, null);
  assert.equal(r.json.effective_root, root);
  assert.equal(r.json.shell_root, root);
  assert.equal(typeof r.json.runtime_revision, "number");
  console.log("OK  health exposes global project/Shell Mode state");

  console.log("\n4 passed, 0 failed");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
