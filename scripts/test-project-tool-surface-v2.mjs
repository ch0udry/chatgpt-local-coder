import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CHATGPT_TOOL_PROFILE = "slim";
const root = await mkdtemp(path.join(tmpdir(), "pws021-"));
const projectA = path.join(root, "project-a");
await mkdir(projectA, { recursive: true });

const [{ createSessionManager, extractRequestId, isInitializeRequest }, { ProjectRuntimeState }] =
  await Promise.all([
    import("../dist/lib/mcp-session-manager.js"),
    import("../dist/lib/project-registry.js"),
  ]);

const runtime = new ProjectRuntimeState({
  version: 2,
  active_project: "a",
  default_project_instruction: "",
  projects: [{
    id: "a",
    name: "A",
    path: projectA,
    use_default_instruction: true,
    instruction: "",
    pinned_skills: [],
  }],
}, root, path.join(root, "projects.toml"));

const app = express();
app.use(express.json());
const config = {
  workspaceRoot: root,
  defaultShellCwd: root,
  shellTimeout: 5,
  workspaceRoots: [projectA],
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

try {
  const init = await rpc({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pws021", version: "1" } },
  });
  const sid = init.response.headers.get("mcp-session-id");
  assert.ok(sid);
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);

  const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sid);
  const names = listed.json.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("runtime_context"));
  assert.ok(names.includes("list_projects"));
  assert.equal(names.includes("use_project"), false);
  console.log("OK  final project MCP surface is read-only for project selection");
  console.log("\n1 passed, 0 failed");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
