import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CHATGPT_TOOL_PROFILE = "slim";
const root = await mkdtemp(path.join(tmpdir(), "pws017-"));
const projectA = path.join(root, "project-a");
const projectB = path.join(root, "project-b");
const globalSkills = path.join(root, "global-skills");
process.env.CHATGPT_GLOBAL_SKILLS_DIR = globalSkills;
await mkdir(projectA, { recursive: true });
await mkdir(projectB, { recursive: true });
await mkdir(path.join(globalSkills, "demo"), { recursive: true });
await mkdir(path.join(projectA, ".claude", "skills", "demo"), { recursive: true });
await mkdir(path.join(projectB, ".claude", "skills", "demo"), { recursive: true });
await writeFile(path.join(root, "marker.txt"), "SHELL", "utf8");
await writeFile(path.join(projectA, "marker.txt"), "A", "utf8");
await writeFile(path.join(projectB, "marker.txt"), "B", "utf8");
await writeFile(path.join(projectA, "AGENTS.md"), "# A\nA_CONTEXT", "utf8");
await writeFile(path.join(projectB, "AGENTS.md"), "# B\nB_CONTEXT", "utf8");
await writeFile(path.join(globalSkills, "demo", "SKILL.md"), "---\nname: demo\ndescription: global\n---\nGLOBAL", "utf8");
await writeFile(path.join(projectA, ".claude", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: a\n---\nPROJECT_A", "utf8");
await writeFile(path.join(projectB, ".claude", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: b\n---\nPROJECT_B", "utf8");

const [{ createSessionManager, extractRequestId, isInitializeRequest }, { ProjectRuntimeState }] =
  await Promise.all([
    import("../dist/lib/mcp-session-manager.js"),
    import("../dist/lib/project-registry.js"),
  ]);

const projects = [
  { id: "a", name: "A", path: projectA, use_default_instruction: true, instruction: "A_CUSTOM", pinned_skills: [] },
  { id: "b", name: "B", path: projectB, use_default_instruction: true, instruction: "B_CUSTOM", pinned_skills: [] },
];
const registryFile = path.join(root, "projects.toml");
const runtime = new ProjectRuntimeState({
  version: 2,
  active_project: "a",
  default_project_instruction: "DEFAULT",
  projects,
}, root, registryFile);

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
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pws017", version: "1" } },
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

try {
  const s1 = await init();
  const s2 = await init();

  for (const sid of [s1, s2]) {
    const listed = await call(sid, "list_projects");
    assert.equal(listed.data.active_project_id, "a");
    assert.equal(listed.data.mode, "project");
    const marker = await call(sid, "read_text_file", { path: "marker.txt" });
    assert.match(marker.data.content, /A/);
  }
  console.log("OK  simultaneous sessions use global Project A");

  const skillA = await call(s1, "load_skill", { name: "demo" });
  assert.equal(skillA.data.source, "project");
  assert.equal(skillA.data.project_id, "a");

  await runtime.activateProject("b");
  for (const sid of [s1, s2]) {
    const listed = await call(sid, "list_projects");
    assert.equal(listed.data.active_project_id, "b");
    const marker = await call(sid, "read_text_file", { path: "marker.txt" });
    assert.match(marker.data.content, /B/);
  }
  const skillB = await call(s2, "load_skill", { name: "demo" });
  assert.equal(skillB.data.project_id, "b");
  console.log("OK  runtime A->B switch is shared by both sessions and skills");

  await runtime.useShellMode();
  for (const sid of [s1, s2]) {
    const listed = await call(sid, "list_projects");
    assert.equal(listed.data.active_project_id, null);
    assert.equal(listed.data.mode, "shell");
    const marker = await call(sid, "read_text_file", { path: "marker.txt" });
    assert.match(marker.data.content, /SHELL/);
  }
  const globalSkill = await call(s1, "load_skill", { name: "demo" });
  assert.equal(globalSkill.data.source, "global");
  assert.equal(globalSkill.data.project_id, null);
  console.log("OK  Shell Mode uses shell root and global skills only");

  const inspected = await call(s1, "project_context", { path: projectA });
  assert.equal(inspected.data.root, projectA);
  assert.equal(runtime.getMode(), "shell");
  assert.equal(runtime.getActiveProject(), null);
  console.log("OK  explicit project inspection does not mutate activation");

  console.log("\n4 passed, 0 failed");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
