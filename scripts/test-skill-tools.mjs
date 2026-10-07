import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CHATGPT_TOOL_PROFILE = "slim";
process.env.MCP_SHELL_STATE_DIR = await mkdtemp(path.join(tmpdir(), "pws006-shell-"));

const root = await mkdtemp(path.join(tmpdir(), "pws006-"));
const project = path.join(root, "project");
const globalDir = path.join(root, "global-skills");
process.env.CHATGPT_GLOBAL_SKILLS_DIR = globalDir;

async function skill(base, dir, name, body) {
  const folder = path.join(base, dir);
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} description\n---\n${body}\n`,
    "utf8"
  );
}

await mkdir(project, { recursive: true });
await skill(path.join(project, ".claude", "skills"), "graphify-query", "graphify-query", "PROJECT_GRAPHIFY_FULL");
await skill(path.join(project, ".claude", "skills"), "alpha-one", "alpha-one", "PROJECT_ALPHA_ONE");
await skill(path.join(project, ".claude", "skills"), "alpha-two", "alpha-two", "PROJECT_ALPHA_TWO");
await skill(globalDir, "graphify-query", "graphify-query", "GLOBAL_GRAPHIFY_FULL");
await skill(globalDir, "global-only", "global-only", "GLOBAL_ONLY_FULL");

const {
  createSessionManager,
  extractRequestId,
  isInitializeRequest,
} = await import("../dist/lib/mcp-session-manager.js");
const { ProjectRuntimeState } = await import("../dist/lib/project-registry.js");

const app = express();
app.use(express.json());
const projectRuntime = new ProjectRuntimeState({
  version: 2,
  active_project: "project",
  default_project_instruction: "",
  projects: [{
    id: "project",
    name: "Project",
    path: project,
    use_default_instruction: true,
    instruction: "",
    pinned_skills: [],
  }],
}, root, path.join(root, "projects.toml"));
const config = {
  workspaceRoot: project,
  defaultShellCwd: root,
  shellTimeout: 5,
  workspaceRoots: [project],
  projectRuntime,
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
if (!address || typeof address === "string") throw new Error("failed to listen");
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

async function callTool(sid, name, args = {}) {
  const { json } = await rpc({
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 100000) + 2,
    method: "tools/call",
    params: { name, arguments: args },
  }, sid);
  return json?.result?.structuredContent;
}

try {
  const init = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "pws006-test", version: "1.0.0" },
    },
  });
  assert.equal(init.response.status, 200);
  const sid = init.response.headers.get("mcp-session-id");
  assert.ok(sid);
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);

  const listedTools = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sid);
  const toolNames = listedTools.json?.result?.tools?.map((tool) => tool.name) ?? [];
  assert.ok(toolNames.includes("list_skills"));
  assert.ok(toolNames.includes("load_skill"));
  console.log("OK  skill tools are exposed in slim profile");

  const listed = await callTool(sid, "list_skills");
  const names = listed.data.skills.map((entry) => [entry.name, entry.source]);
  assert.deepEqual(names.filter(([name]) => name === "graphify-query"), [["graphify-query", "project"]]);
  assert.ok(names.some(([name, source]) => name === "global-only" && source === "global"));
  console.log("OK  list_skills applies project-first/global-fallback");

  const projectSkill = await callTool(sid, "load_skill", { name: "graphify-query" });
  assert.equal(projectSkill.ok, true);
  assert.equal(projectSkill.data.source, "project");
  assert.equal(projectSkill.data.project_id, "project");
  assert.match(projectSkill.data.content, /PROJECT_GRAPHIFY_FULL/);
  assert.doesNotMatch(projectSkill.data.content, /GLOBAL_GRAPHIFY_FULL/);
  console.log("OK  same-name collision resolves to project skill with full content");

  const globalSkill = await callTool(sid, "load_skill", { name: "global-only" });
  assert.equal(globalSkill.ok, true);
  assert.equal(globalSkill.data.source, "global");
  assert.match(globalSkill.data.content, /GLOBAL_ONLY_FULL/);
  console.log("OK  project miss falls back to global skill");

  const alias = await callTool(sid, "load_skill", { name: "graphify" });
  assert.equal(alias.ok, true);
  assert.equal(alias.data.name, "graphify-query");
  assert.equal(alias.data.source, "project");
  console.log("OK  unique alias resolves deterministically");

  const ambiguous = await callTool(sid, "load_skill", { name: "alpha" });
  assert.equal(ambiguous.ok, false);
  assert.deepEqual(ambiguous.data.candidates.map((entry) => entry.name), ["alpha-one", "alpha-two"]);
  console.log("OK  ambiguous alias returns explicit candidates");

  await skill(globalDir, "fresh-added", "fresh-added", "FRESH_WITHOUT_RESTART");
  const fresh = await callTool(sid, "load_skill", { name: "fresh-added" });
  assert.equal(fresh.ok, true);
  assert.match(fresh.data.content, /FRESH_WITHOUT_RESTART/);
  console.log("OK  newly added skill is visible without restart");

  await projectRuntime.useShellMode();
  const shellGlobal = await callTool(sid, "load_skill", { name: "graphify-query" });
  assert.equal(shellGlobal.ok, true);
  assert.equal(shellGlobal.data.source, "global");
  assert.match(shellGlobal.data.content, /GLOBAL_GRAPHIFY_FULL/);
  console.log("OK  no active project resolves global skills for shell work");

  console.log("\n7 passed, 0 failed");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
