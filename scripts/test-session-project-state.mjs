import assert from "node:assert/strict";
import express from "express";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MCP_SHELL_STATE_DIR = await mkdtemp(path.join(tmpdir(), "pws-shell-state-"));

const {
  createSessionManager,
  extractRequestId,
  isInitializeRequest,
} = await import("../dist/lib/mcp-session-manager.js");

async function createHarness(primaryProjectId) {
  const app = express();
  app.use(express.json());

  const config = {
    workspaceRoot: process.cwd(),
    defaultShellCwd: process.cwd(),
    shellTimeout: 5,
    workspaceRoots: [process.cwd()],
    port: 0,
    primaryProjectId,
  };

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
  if (!address || typeof address === "string") throw new Error("failed to start test server");
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

  return { response, json: await response.json() };
}

async function initialize(harness) {
  const { response } = await post(harness.base, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "pws-session-test", version: "1.0.0" },
    },
  });

  assert.equal(response.status, 200);
  const sessionId = response.headers.get("mcp-session-id");
  assert.ok(sessionId);
  return sessionId;
}

let passed = 0;
function ok(name) {
  console.log(`OK  ${name}`);
  passed++;
}

const harness = await createHarness("project-a");
try {
  const sessionA = await initialize(harness);
  const sessionB = await initialize(harness);

  assert.equal(harness.manager.get(sessionA)?.activeProjectId, "project-a");
  assert.equal(harness.manager.get(sessionB)?.activeProjectId, "project-a");
  ok("new sessions default to primary project");

  harness.manager.setActiveProject(sessionA, "project-b");
  assert.equal(harness.manager.get(sessionA)?.activeProjectId, "project-b");
  assert.equal(harness.manager.get(sessionB)?.activeProjectId, "project-a");
  ok("active project is isolated per session");

  const staleId = "00000000-0000-4000-8000-000000000123";
  const recovered = await post(
    harness.base,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    staleId
  );
  assert.equal(recovered.response.status, 200);
  assert.equal(harness.manager.get(staleId)?.activeProjectId, "project-a");
  ok("stale recovery reconstructs primary project deterministically");
} finally {
  await new Promise((resolve) => harness.server.close(resolve));
}

const shellOnly = await createHarness(null);
try {
  const session = await initialize(shellOnly);
  assert.equal(shellOnly.manager.get(session)?.activeProjectId, null);
  ok("shell-only session works without a primary project");
} finally {
  await new Promise((resolve) => shellOnly.server.close(resolve));
}

console.log(`\n${passed} passed, 0 failed`);
