import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CHATGPT_TOOL_PROFILE = "slim";
const root = await mkdtemp(path.join(tmpdir(), "pws018-"));
const projectA = path.join(root, "project-a");
const projectB = path.join(root, "project-b");
await mkdir(projectA, { recursive: true });
await mkdir(projectB, { recursive: true });
await writeFile(path.join(projectA, "AGENTS.md"), "# A\nA_CONTEXT", "utf8");
await writeFile(path.join(projectB, "AGENTS.md"), "# B\nB_CONTEXT", "utf8");

const [{ createSessionManager, extractRequestId, isInitializeRequest }, { ProjectRuntimeState }] =
  await Promise.all([
    import("../dist/lib/mcp-session-manager.js"),
    import("../dist/lib/project-registry.js"),
  ]);

const runtime = new ProjectRuntimeState({
  version: 2,
  active_project: "a",
  default_project_instruction: "DEFAULT_CONTEXT",
  projects: [
    { id: "a", name: "A", path: projectA, use_default_instruction: true, instruction: "A_CUSTOM", pinned_skills: [] },
    { id: "b", name: "B", path: projectB, use_default_instruction: true, instruction: "B_CUSTOM", pinned_skills: [] },
  ],
}, root, path.join(root, "projects.toml"));

const app = express();
app.use(express.json());
const config = {
  workspaceRoot: root,
  defaultShellCwd: root,
  shellTimeout: 5,
  workspaceRoots: [projectA, projectB],
  projectRuntime: runtime,
  pid: process.pid,
  adminPort: 3331,
  port: 0,
};
const manager = createSessionManager(config);

app.post("/mcp", async (req, res) => {
  const sid = req.headers["mcp-session-id"];
  const existing = sid ? manager.get(sid) : undefined;
  if (existing) return manager.handleExisting(existing, req, res, req.body);
  if (isInitializeRequest(req.body)) return manager.createNew(req, res, req.body);
  manager.sendBadRequest(res, "missing session", extractRequestId(req.body));
});

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("listen failed");
config.port = address.port;
const base = `http://127.0.0.1:${address.port}/mcp`;

async function rpc(body, sid) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (sid) {
    headers["mcp-session-id"] = sid;
    headers["mcp-protocol-version"] = "2025-03-26";
  }
  const response = await fetch(base, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  return { response, json: text ? JSON.parse(text) : null };
}

async function init() {
  const result = await rpc({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pws018", version: "1" } },
  });
  const sid = result.response.headers.get("mcp-session-id");
  assert.ok(sid);
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  return { sid, instructions: result.json?.result?.instructions ?? "" };
}
async function call(sid, name, args = {}) {
  const { json } = await rpc({
    jsonrpc: "2.0", id: Math.floor(Math.random() * 100000) + 2, method: "tools/call",
    params: { name, arguments: args },
  }, sid);
  return json?.result?.structuredContent;
}

try {
  const { sid, instructions } = await init();
  assert.match(instructions, /runtime_context/);
  assert.doesNotMatch(instructions, /A_CONTEXT|A_CUSTOM|B_CONTEXT|B_CUSTOM/);
  console.log("OK  initialize instructions are static and require runtime_context");

  const a = await call(sid, "runtime_context");
  assert.equal(a.data.mode, "project");
  assert.equal(a.data.active_project_id, "a");
  assert.equal(a.data.active_project_path, projectA);
  assert.match(a.data.project_context.instructions, /A_CONTEXT/);
  assert.match(a.data.project_context.instructions, /A_CUSTOM/);
  console.log("OK  runtime_context returns current Project A context");

  await runtime.activateProject("b");
  const b = await call(sid, "runtime_context");
  assert.equal(b.data.active_project_id, "b");
  assert.match(b.data.project_context.instructions, /B_CONTEXT/);
  assert.doesNotMatch(b.data.project_context.instructions, /A_CONTEXT/);
  console.log("OK  same MCP session sees Project B without reinitialize");

  await runtime.useShellMode();
  const shell = await call(sid, "runtime_context");
  assert.equal(shell.data.mode, "shell");
  assert.equal(shell.data.active_project_id, null);
  assert.equal(shell.data.active_project_path, null);
  assert.equal(shell.data.effective_root, root);
  assert.equal(shell.data.project_context, null);
  assert.match(shell.data.directive, /No project is active/i);
  console.log("OK  same MCP session sees clean Shell Mode without project context");

  console.log("\n4 passed, 0 failed");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
