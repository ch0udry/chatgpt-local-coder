import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CHATGPT_TOOL_PROFILE = "full";
process.env.MCP_SHELL_STATE_DIR = await mkdtemp(path.join(tmpdir(), "pws005-shell-"));

const {
  createSessionManager,
  isInitializeRequest,
} = await import("../dist/lib/mcp-session-manager.js");
const { ProjectRuntimeState } = await import("../dist/lib/project-registry.js");

const root = await mkdtemp(path.join(tmpdir(), "pws005-"));
const project = path.join(root, "project");
await mkdir(project);
await writeFile(path.join(project, "AGENTS.md"), "# Test\nPWS005-AGENT-MARKER\n", "utf8");
const projectRuntime = new ProjectRuntimeState({
  version: 2,
  active_project: "project",
  default_project_instruction: "PWS005-DEFAULT-MARKER",
  projects: [{
    id: "project",
    name: "Project",
    path: project,
    use_default_instruction: true,
    instruction: "PWS005-CUSTOM-MARKER",
    pinned_skills: [],
  }],
}, project, path.join(root, "projects.toml"));

const app = express();
app.use(express.json());

const config = {
  workspaceRoot: project,
  defaultShellCwd: project,
  shellTimeout: 5,
  workspaceRoots: [project],
  projectRuntime,
  pid: process.pid,
  adminPort: 3331,
  port: 0,
};

const manager = createSessionManager(config);

app.post("/mcp", async (req, res) => {
  if (!isInitializeRequest(req.body)) {
    res.status(400).json({ error: "initialize only" });
    return;
  }
  await manager.createNew(req, res, req.body);
});

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to start");
config.port = address.port;

try {
  const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "pws005-test", version: "1.0.0" },
      },
    }),
  });

  assert.equal(response.status, 200);
  const json = await response.json();
  const instructions = json?.result?.instructions;
  assert.equal(typeof instructions, "string");
  assert.match(instructions, /Agent workflow/);
  assert.match(instructions, /runtime_context/);
  assert.doesNotMatch(instructions, /PWS005-DEFAULT-MARKER/);
  assert.doesNotMatch(instructions, /PWS005-CUSTOM-MARKER|PWS005-AGENT-MARKER/);

  console.log("OK  initialize response contains static core instructions");
  console.log("OK  initialize instructions require runtime_context");
  console.log("OK  mutable project/default/repo context is not embedded at initialize");
  console.log("\n3 passed, 0 failed");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
