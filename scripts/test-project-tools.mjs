import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CHATGPT_TOOL_PROFILE = "slim";
process.env.MCP_SHELL_STATE_DIR = await mkdtemp(path.join(tmpdir(), "pws007-shell-"));

const root = await mkdtemp(path.join(tmpdir(), "pws007-"));
const projectA = path.join(root, "project-a");
const projectB = path.join(root, "project-b");
await mkdir(projectA, { recursive: true });
await mkdir(projectB, { recursive: true });
await writeFile(path.join(projectA, "marker.txt"), "A", "utf8");
await writeFile(path.join(projectB, "marker.txt"), "B", "utf8");
await writeFile(path.join(projectA, "AGENTS.md"), "# A\nA_CONTEXT", "utf8");
await writeFile(path.join(projectB, "AGENTS.md"), "# B\nB_CONTEXT", "utf8");

const {
  createSessionManager,
  extractRequestId,
  isInitializeRequest,
} = await import("../dist/lib/mcp-session-manager.js");

const projects = [
  {
    id: "a",
    name: "Same Name",
    path: projectA,
    use_default_instruction: true,
    instruction: "A_CUSTOM",
    pinned_skills: [],
  },
  {
    id: "b",
    name: "Same Name",
    path: projectB,
    use_default_instruction: true,
    instruction: "B_CUSTOM",
    pinned_skills: [],
  },
];

const app = express();
app.use(express.json());
const config = {
  workspaceRoot: projectA,
  defaultShellCwd: root,
  shellTimeout: 5,
  workspaceRoots: [projectA, projectB],
  projects,
  primaryProjectId: "a",
  defaultProjectInstruction: "DEFAULT_CONTEXT",
  pid: process.pid,
  adminPort: 3331,
  port: 0,
};
const manager = createSessionManager(config);

app.post("/mcp", async (req, res) => {
  const sid = req.headers["mcp-session-id"];
  const existing = sid ? manager.get(sid) : undefined;
  if (existing) {
    await manager.handleExisting(existing, req, res, req.body);
    return;
  }
  if (isInitializeRequest(req.body)) {
    await manager.createNew(req, res, req.body);
    return;
  }
  manager.sendBadRequest(res, "missing session", extractRequestId(req.body));
});

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("listen failed");
config.port = address.port;
const base = `http://127.0.0.1:${address.port}/mcp`;

async function rpc(body, sid) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
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
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 100000),
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "pws007-test", version: "1.0.0" },
    },
  });
  const sid = result.response.headers.get("mcp-session-id");
  assert.ok(sid);
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  return sid;
}

async function call(sid, name, args = {}) {
  const { json } = await rpc({
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 100000) + 1,
    method: "tools/call",
    params: { name, arguments: args },
  }, sid);
  return json?.result?.structuredContent;
}

try {
  const s1 = await init();
  const s2 = await init();

  const tools = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, s1);
  const names = tools.json?.result?.tools?.map((tool) => tool.name) ?? [];
  assert.ok(names.includes("list_projects"));
  assert.ok(names.includes("use_project"));
  console.log("OK  project selection tools are exposed");

  const initial = await call(s1, "list_projects");
  const a = initial.data.projects.find((project) => project.id === "a");
  const b = initial.data.projects.find((project) => project.id === "b");
  assert.equal(a.primary, true);
  assert.equal(a.active, true);
  assert.equal(b.primary, false);
  assert.equal(b.active, false);
  assert.equal(a.context.has_agents, true);
  console.log("OK  list_projects reports primary, active and context summary");

  const selected = await call(s1, "use_project", { project: "b" });
  assert.equal(selected.ok, true);
  assert.equal(selected.data.project.id, "b");
  assert.match(selected.data.instructions, /B_CONTEXT/);
  assert.match(selected.data.instructions, /B_CUSTOM/);

  const readB = await call(s1, "read_text_file", { path: "marker.txt" });
  assert.match(readB.data.content, /B/);
  const readA = await call(s2, "read_text_file", { path: "marker.txt" });
  assert.match(readA.data.content, /A/);
  console.log("OK  use_project changes only the current session defaults/context");

  const after = await call(s1, "list_projects");
  assert.equal(after.data.projects.find((project) => project.id === "a").primary, true);
  assert.equal(after.data.projects.find((project) => project.id === "b").active, true);
  console.log("OK  session selection does not mutate global primary project");

  const inspectA = await call(s1, "project_context", { path: projectA });
  assert.equal(inspectA.data.root, projectA);
  const stillB = await call(s1, "read_text_file", { path: "marker.txt" });
  assert.match(stillB.data.content, /B/);
  console.log("OK  project_context remains inspection-only");

  const byPath = await call(s1, "use_project", { project: projectA });
  assert.equal(byPath.ok, true);
  assert.equal(byPath.data.project.id, "a");
  console.log("OK  exact registered absolute path can select a project");

  const ambiguousName = await call(s1, "use_project", { project: "Same Name" });
  assert.equal(ambiguousName.ok, false);
  assert.deepEqual(ambiguousName.data.candidates.map((project) => project.id), ["a", "b"]);

  const unknown = await call(s1, "use_project", { project: "does-not-exist" });
  assert.equal(unknown.ok, false);
  console.log("OK  ambiguous/unknown project is not guessed");

  console.log("\n6 passed, 0 failed");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
