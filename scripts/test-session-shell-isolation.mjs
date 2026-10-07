import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CHATGPT_TOOL_PROFILE = "slim";
process.env.MCP_SHELL_STATE_DIR = await mkdtemp(path.join(tmpdir(), "pws019-state-"));
const root = await mkdtemp(path.join(tmpdir(), "pws019-"));
const projectA = path.join(root, "project-a");
const projectB = path.join(root, "project-b");
const subA = path.join(projectA, "sub");
await mkdir(subA, { recursive: true });
await mkdir(projectB, { recursive: true });

const [{ createSessionManager, extractRequestId, isInitializeRequest }, { ProjectRuntimeState }] =
  await Promise.all([
    import("../dist/lib/mcp-session-manager.js"),
    import("../dist/lib/project-registry.js"),
  ]);
const { createPersistentShellSession } = await import("../dist/lib/persistent-shell.js");

const runtime = new ProjectRuntimeState({
  version: 2,
  active_project: "a",
  default_project_instruction: "",
  projects: [
    { id: "a", name: "A", path: projectA, use_default_instruction: true, instruction: "", pinned_skills: [] },
    { id: "b", name: "B", path: projectB, use_default_instruction: true, instruction: "", pinned_skills: [] },
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
    jsonrpc: "2.0", id: Math.floor(Math.random() * 100000), method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pws019", version: "1" } },
  });
  const sid = result.response.headers.get("mcp-session-id");
  assert.ok(sid);
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  return sid;
}
async function call(sid, name, args = {}) {
  const { json } = await rpc({
    jsonrpc: "2.0", id: Math.floor(Math.random() * 100000) + 1, method: "tools/call",
    params: { name, arguments: args },
  }, sid);
  return json?.result?.structuredContent;
}
function normalized(p) { return path.resolve(p); }

try {
  const s1 = await init();
  const s2 = await init();

  const initial1 = await call(s1, "run_command", { command: "pwd" });
  const initial2 = await call(s2, "run_command", { command: "pwd" });
  assert.equal(normalized(initial1.data.cwd), normalized(projectA));
  assert.equal(normalized(initial2.data.cwd), normalized(projectA));

  await call(s1, "run_command", { command: "cd sub" });
  const changed1 = await call(s1, "run_command", { command: "pwd" });
  const unchanged2 = await call(s2, "run_command", { command: "pwd" });
  assert.equal(normalized(changed1.data.cwd), normalized(subA));
  assert.equal(normalized(unchanged2.data.cwd), normalized(projectA));
  console.log("OK  one MCP session cd does not leak into another session");

  await runtime.activateProject("b");
  const b1 = await call(s1, "run_command", { command: "pwd" });
  const b2 = await call(s2, "run_command", { command: "pwd" });
  assert.equal(normalized(b1.data.cwd), normalized(projectB));
  assert.equal(normalized(b2.data.cwd), normalized(projectB));
  console.log("OK  project switch resets each session to new effective root");

  await runtime.useShellMode();
  const shell1 = await call(s1, "run_command", { command: "pwd" });
  const shell2 = await call(s2, "run_command", { command: "pwd" });
  assert.equal(normalized(shell1.data.cwd), normalized(root));
  assert.equal(normalized(shell2.data.cwd), normalized(root));
  console.log("OK  Shell Mode resets each session to shell root");

  let recoveryRoot = projectA;
  let recoveryKey = "project:a:" + projectA;
  const first = createPersistentShellSession("recovery-session", () => recoveryRoot, () => recoveryKey);
  await first.exec("cd sub", 5000);
  const recovered = createPersistentShellSession("recovery-session", () => recoveryRoot, () => recoveryKey);
  assert.equal(normalized(await recovered.getCwd()), normalized(subA));
  recoveryRoot = projectB;
  recoveryKey = "project:b:" + projectB;
  assert.equal(normalized(await recovered.getCwd()), normalized(projectB));
  console.log("OK  same-id recovery restores cwd only for matching shell context");

  console.log("\n4 passed, 0 failed");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
