import assert from "node:assert/strict";
import express from "express";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CHATGPT_TOOL_PROFILE = "full";
process.env.MCP_SHELL_STATE_DIR = await mkdtemp(path.join(tmpdir(), "pws003-shell-state-"));

const { setDefaultCwd } = await import("../dist/lib/path-security.js");
const {
  createSessionManager,
  extractRequestId,
  isInitializeRequest,
} = await import("../dist/lib/mcp-session-manager.js");

async function makeRepo(root, name) {
  const dir = path.join(root, name);
  await mkdir(dir);
  await writeFile(path.join(dir, "marker.txt"), name, "utf8");
  await writeFile(path.join(dir, "AGENTS.md"), `# ${name}\n`, "utf8");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

async function createHarness(config) {
  const app = express();
  app.use(express.json());
  const manager = createSessionManager(config);

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    const existing = sessionId ? manager.get(sessionId) : undefined;

    if (existing) {
      await manager.handleExisting(existing, req, res, req.body);
      return;
    }
    if (isInitializeRequest(req.body)) {
      await manager.createNew(req, res, req.body);
      return;
    }
    if (sessionId) {
      const recovered = await manager.tryRecoverStale(sessionId, req, res, req.body);
      if (!recovered && !res.headersSent) {
        manager.sendSessionNotFound(res, extractRequestId(req.body));
      }
      return;
    }
    manager.sendBadRequest(res, "missing session", extractRequestId(req.body));
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to start server");
  config.port = address.port;
  return { manager, server, base: `http://127.0.0.1:${address.port}` };
}

async function post(base, body, sessionId) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
    headers["mcp-protocol-version"] = "2025-03-26";
  }
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, json: text ? JSON.parse(text) : null };
}

async function initialize(harness) {
  const { response } = await post(harness.base, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "pws003-test", version: "1.0.0" },
    },
  });
  assert.equal(response.status, 200);
  const sessionId = response.headers.get("mcp-session-id");
  assert.ok(sessionId);
  await post(harness.base, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  return sessionId;
}

async function callTool(harness, sessionId, name, args = {}) {
  const { response, json } = await post(
    harness.base,
    { jsonrpc: "2.0", id: Math.floor(Math.random() * 100000) + 2, method: "tools/call", params: { name, arguments: args } },
    sessionId
  );
  assert.equal(response.status, 200);
  const payload = json?.result?.structuredContent;
  assert.ok(payload, `missing structured content for ${name}: ${JSON.stringify(json)}`);
  return payload;
}

const root = await mkdtemp(path.join(tmpdir(), "pws003-"));
const projectA = await makeRepo(root, "project-a");
const projectB = await makeRepo(root, "project-b");
const outside = await makeRepo(root, "outside-repo");
const shellCwd = path.join(root, "shell");
await mkdir(shellCwd);
setDefaultCwd(shellCwd);

const config = {
  workspaceRoot: projectA,
  defaultShellCwd: shellCwd,
  shellTimeout: 5,
  workspaceRoots: [projectA, projectB],
  projects: [
    { id: "a", path: projectA },
    { id: "b", path: projectB },
  ],
  primaryProjectId: "a",
  port: 0,
};

const harness = await createHarness(config);
let passed = 0;
const ok = (name) => { console.log(`OK  ${name}`); passed++; };

try {
  const sessionId = await initialize(harness);

  const readA = await callTool(harness, sessionId, "read_text_file", { path: "marker.txt" });
  assert.equal(readA.data.path, path.join(projectA, "marker.txt"));
  assert.match(readA.data.content, /project-a/);

  const gitA = await callTool(harness, sessionId, "git_status");
  assert.equal(gitA.data.path, projectA);

  const contextA = await callTool(harness, sessionId, "project_context");
  assert.equal(contextA.data.root, projectA);
  ok("project tools default to primary active project");

  harness.manager.setActiveProject(sessionId, "b");

  const readB = await callTool(harness, sessionId, "read_text_file", { path: "marker.txt" });
  assert.equal(readB.data.path, path.join(projectB, "marker.txt"));
  assert.match(readB.data.content, /project-b/);

  const gitB = await callTool(harness, sessionId, "git_status");
  assert.equal(gitB.data.path, projectB);

  const contextB = await callTool(harness, sessionId, "project_context");
  assert.equal(contextB.data.root, projectB);
  ok("changing active project changes filesystem/git/context defaults");

  const absoluteRead = await callTool(harness, sessionId, "read_text_file", {
    path: path.join(outside, "marker.txt"),
  });
  assert.equal(absoluteRead.data.path, path.join(outside, "marker.txt"));

  const absoluteGit = await callTool(harness, sessionId, "git_status", { path: outside });
  assert.equal(absoluteGit.data.path, outside);

  const absoluteContext = await callTool(harness, sessionId, "project_context", { path: outside });
  assert.equal(absoluteContext.data.root, outside);
  ok("explicit absolute paths remain full-machine capable");

  const shell = await callTool(harness, sessionId, "run_command", {
    command: "pwd",
    working_directory: "/",
  });
  assert.equal(shell.data.cwd, "/");
  ok("shell explicit machine cwd remains available");
} finally {
  await new Promise((resolve) => harness.server.close(resolve));
}

console.log(`\n${passed} passed, 0 failed`);
