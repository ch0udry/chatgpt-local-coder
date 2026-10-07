import assert from "node:assert/strict";
import express from "express";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CHATGPT_TOOL_PROFILE = "slim";
const root = await mkdtemp(path.join(tmpdir(), "pws022-"));
const projectA = path.join(root, "project-a");
const projectB = path.join(root, "project-b");
const shellRoot = path.join(root, "shell-root");
const globalSkills = path.join(root, "global-skills");
const registryPath = path.join(root, "profiles", "projects.toml");
process.env.CHATGPT_GLOBAL_SKILLS_DIR = globalSkills;
process.env.MCP_SHELL_STATE_DIR = path.join(root, "shell-state");

for (const dir of [
  projectA,
  projectB,
  shellRoot,
  path.join(projectA, "sub"),
  path.join(projectA, ".claude", "skills", "graphify-query"),
  path.join(projectB, ".claude", "skills", "graphify-query"),
  path.join(globalSkills, "graphify-query"),
]) {
  await mkdir(dir, { recursive: true });
}

await writeFile(path.join(projectA, "marker.txt"), "PROJECT_A", "utf8");
await writeFile(path.join(projectB, "marker.txt"), "PROJECT_B", "utf8");
await writeFile(path.join(shellRoot, "marker.txt"), "SHELL_ROOT", "utf8");
await writeFile(path.join(projectA, "AGENTS.md"), "# A\nA_CONTEXT", "utf8");
await writeFile(path.join(projectB, "AGENTS.md"), "# B\nB_CONTEXT", "utf8");
await writeFile(
  path.join(projectA, ".claude", "skills", "graphify-query", "SKILL.md"),
  "---\nname: graphify-query\ndescription: project a\n---\nPROJECT_A_SKILL",
  "utf8"
);
await writeFile(
  path.join(projectB, ".claude", "skills", "graphify-query", "SKILL.md"),
  "---\nname: graphify-query\ndescription: project b\n---\nPROJECT_B_SKILL",
  "utf8"
);
await writeFile(
  path.join(globalSkills, "graphify-query", "SKILL.md"),
  "---\nname: graphify-query\ndescription: global\n---\nGLOBAL_SKILL",
  "utf8"
);

for (const repo of [projectA, projectB]) {
  execFileSync("git", ["init", "-q"], { cwd: repo });
}

const [
  { createSessionManager, extractRequestId, isInitializeRequest },
  { createAdminRouter },
  { ProjectRuntimeState, loadProjectRegistry, saveProjectRegistry },
] = await Promise.all([
  import("../dist/lib/mcp-session-manager.js"),
  import("../dist/admin/routes.js"),
  import("../dist/lib/project-registry.js"),
]);

const registry = {
  version: 2,
  active_project: "a",
  default_project_instruction: "DEFAULT_RULE",
  projects: [
    { id: "a", name: "A", path: projectA, use_default_instruction: true, instruction: "A_CUSTOM", pinned_skills: [] },
    { id: "b", name: "B", path: projectB, use_default_instruction: true, instruction: "B_CUSTOM", pinned_skills: [] },
  ],
};
await saveProjectRegistry(registry, registryPath);
const runtime = new ProjectRuntimeState(registry, shellRoot, registryPath);

const upstreamManager = {
  listStatuses: async () => [],
  getConfig: () => ({ version: 1, servers: [] }),
  getConfigPath: () => path.join(root, "mcp-upstream.json"),
  listServerConfigs: () => [],
};

const app = express();
app.use(express.json());
const mcpConfig = {
  workspaceRoot: projectA,
  defaultShellCwd: shellRoot,
  shellTimeout: 5,
  workspaceRoots: [projectA, projectB],
  projectRuntime: runtime,
  pid: process.pid,
  adminPort: 0,
  port: 0,
};
const sessions = createSessionManager(mcpConfig);

app.post("/mcp", async (req, res) => {
  const sid = req.headers["mcp-session-id"];
  const existing = sid ? sessions.get(sid) : undefined;
  if (existing) return sessions.handleExisting(existing, req, res, req.body);
  if (isInitializeRequest(req.body)) return sessions.createNew(req, res, req.body);
  sessions.sendBadRequest(res, "missing session", extractRequestId(req.body));
});
app.use(createAdminRouter(upstreamManager, {
  mcpPort: 0,
  pid: process.pid,
  sessionCount: () => sessions.count(),
  projectRuntime: runtime,
}));

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("listen failed");
mcpConfig.port = address.port;
const base = `http://127.0.0.1:${address.port}`;

async function rpc(body, sid) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sid) {
    headers["mcp-session-id"] = sid;
    headers["mcp-protocol-version"] = "2025-03-26";
  }
  const response = await fetch(base + "/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, json: text ? JSON.parse(text) : null };
}

async function initSession(label) {
  const initialized = await rpc({
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 100000),
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: label, version: "1" },
    },
  });
  const sid = initialized.response.headers.get("mcp-session-id");
  assert.ok(sid);
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  return sid;
}

async function call(sid, name, args = {}) {
  const result = await rpc({
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 100000) + 1,
    method: "tools/call",
    params: { name, arguments: args },
  }, sid);
  if (result.json?.error) throw new Error(JSON.stringify(result.json.error));
  return result.json?.result?.structuredContent?.data;
}

async function admin(method, url, body) {
  const response = await fetch(base + url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}

function norm(value) {
  return path.resolve(value);
}

try {
  const s1 = await initSession("pws022-a");
  const s2 = await initSession("pws022-b");

  for (const sid of [s1, s2]) {
    const ctx = await call(sid, "runtime_context");
    assert.equal(ctx.mode, "project");
    assert.equal(ctx.active_project_id, "a");
    assert.equal(norm(ctx.effective_root), norm(projectA));

    const listed = await call(sid, "list_projects");
    assert.equal(listed.active_project_id, "a");
    assert.equal(listed.projects.find((p) => p.id === "a").active, true);

    const marker = await call(sid, "read_text_file", { path: "marker.txt" });
    assert.match(marker.content, /PROJECT_A/);

    const git = await call(sid, "git_status");
    assert.equal(norm(git.path), norm(projectA));

    const skill = await call(sid, "load_skill", { name: "graphify-query" });
    assert.equal(skill.source, "project");
    assert.equal(skill.project_id, "a");
  }
  console.log("OK  two sessions share Project A defaults, git and project skill");

  await call(s1, "run_command", { command: "cd sub" });
  const s1Pwd = await call(s1, "run_command", { command: "pwd" });
  const s2Pwd = await call(s2, "run_command", { command: "pwd" });
  assert.equal(norm(s1Pwd.cwd), norm(path.join(projectA, "sub")));
  assert.equal(norm(s2Pwd.cwd), norm(projectA));
  console.log("OK  shell cwd is isolated per MCP session");

  await admin("PUT", "/api/projects/b/activate");
  for (const sid of [s1, s2]) {
    const ctx = await call(sid, "runtime_context");
    assert.equal(ctx.active_project_id, "b");
    const marker = await call(sid, "read_text_file", { path: "marker.txt" });
    assert.match(marker.content, /PROJECT_B/);
    const git = await call(sid, "git_status");
    assert.equal(norm(git.path), norm(projectB));
    const skill = await call(sid, "load_skill", { name: "graphify-query" });
    assert.equal(skill.source, "project");
    assert.equal(skill.project_id, "b");
    const pwd = await call(sid, "run_command", { command: "pwd" });
    assert.equal(norm(pwd.cwd), norm(projectB));
  }
  console.log("OK  Admin A->B switch is observed by both sessions on next work");

  const restartedProject = new ProjectRuntimeState(
    await loadProjectRegistry(registryPath),
    shellRoot,
    registryPath
  );
  assert.equal(restartedProject.getActiveProject()?.id, "b");
  console.log("OK  active Project B persists across registry reload/restart");

  const process = await call(s1, "start_process", { command: "sleep 2" });
  await admin("PUT", "/api/projects/shell");
  const processAfterSwitch = await call(s1, "process_output", { id: process.id });
  assert.equal(processAfterSwitch.running, true);
  console.log("OK  switching mode does not terminate an existing background process");

  for (const sid of [s1, s2]) {
    const ctx = await call(sid, "runtime_context");
    assert.equal(ctx.mode, "shell");
    assert.equal(ctx.active_project_id, null);
    assert.equal(norm(ctx.effective_root), norm(shellRoot));

    const marker = await call(sid, "read_text_file", { path: "marker.txt" });
    assert.match(marker.content, /SHELL_ROOT/);

    const skill = await call(sid, "load_skill", { name: "graphify-query" });
    assert.equal(skill.source, "global");
    assert.equal(skill.project_id, null);

    const pwd = await call(sid, "run_command", { command: "pwd" });
    assert.equal(norm(pwd.cwd), norm(shellRoot));
  }
  console.log("OK  Shell Mode gives shell root and global skills only to both sessions");

  const absolute = await call(s1, "read_text_file", { path: path.join(projectA, "marker.txt") });
  assert.match(absolute.content, /PROJECT_A/);
  assert.equal((await call(s1, "runtime_context")).active_project_id, null);

  const inspected = await call(s1, "project_context", { path: projectA });
  assert.equal(norm(inspected.root), norm(projectA));
  assert.equal((await call(s1, "runtime_context")).active_project_id, null);

  await call(s1, "load_path_rules", { path: path.join(projectA, "marker.txt") });
  assert.equal((await call(s1, "runtime_context")).active_project_id, null);
  console.log("OK  explicit path/project/rule inspection does not mutate activation");

  const restartedShell = new ProjectRuntimeState(
    await loadProjectRegistry(registryPath),
    shellRoot,
    registryPath
  );
  assert.equal(restartedShell.getMode(), "shell");
  assert.equal(restartedShell.getActiveProject(), null);
  console.log("OK  Shell Mode persists across registry reload/restart");

  console.log("\n7 passed, 0 failed");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
