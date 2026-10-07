#!/usr/bin/env node

import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { randomUUID } from "crypto";

import { setDefaultCwd } from "./lib/path-security.js";
import {
  consumeSessionTransportError,
  createSessionManager,
  extractRequestId,
  isInitializeRequest,
} from "./lib/mcp-session-manager.js";
import { initUpstreamManager } from "./lib/mcp-upstream-manager.js";
import { startContextEngineDiscovery } from "./lib/context-engine-discovery.js";
import { startAdminServer } from "./admin/server.js";
import { logMcpHttpEvent, logMcpRequest } from "./lib/activity-log.js";
import {
  buildInstructionContext,
  summarizeInstructionContext,
  type InstructionContext,
} from "./lib/instruction-context.js";
import { getChatGptToolProfile } from "./lib/tool-profile.js";
import { createOAuthShimRouter } from "./lib/oauth-shim.js";
import {
  loadOrBootstrapProjectRegistry,
  resolvePrimaryProject,
} from "./lib/project-registry.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";
const MCP_TOKEN = (process.env.MCP_TOKEN || "").trim();
const MCP_TOKEN_NEXT = (process.env.MCP_TOKEN_NEXT || "").trim();
const ADMIN_PORT = parseInt(process.env.ADMIN_PORT || "3001", 10);
const SHELL_TIMEOUT = parseInt(process.env.SHELL_TIMEOUT || "120", 10);
const SESSION_RECOVERY =
  (process.env.MCP_SESSION_RECOVERY || "true").toLowerCase() !== "false";

const projectRegistry = await loadOrBootstrapProjectRegistry(process.env);
const primaryProject = resolvePrimaryProject(projectRegistry);
const workspaceRoots = projectRegistry.projects.map((project) => project.path);
const workspaceRoot =
  primaryProject?.path ?? path.resolve(process.env.WORKSPACE_PATH || process.cwd());
const defaultShellCwd = path.resolve(process.env.DEFAULT_SHELL_CWD || workspaceRoot);
setDefaultCwd(defaultShellCwd);

const upstreamManager = await initUpstreamManager();
const stopContextEngineDiscovery = await startContextEngineDiscovery(upstreamManager);

const instructionContext: InstructionContext = await buildInstructionContext({
  workspaceRoot,
  workspaceRoots,
  pid: process.pid,
  adminPort: ADMIN_PORT,
});

if (instructionContext.projectMemory.sections.length > 0) {
  console.log(
    `[MCP] Project memory: ${instructionContext.projectMemory.sections.length} file(s) from ${workspaceRoot} (${instructionContext.projectMemory.total_bytes} bytes)`
  );
} else {
  console.log(
    `[MCP] Project memory: no CLAUDE.md/AGENTS.md at ${workspaceRoot} — set WORKSPACE_PATH to your project root`
  );
}
if (instructionContext.git.is_repo) {
  console.log(`[MCP] Git: branch ${instructionContext.git.branch}`);
}
console.log(
  `[MCP] MCP instructions: ${Math.round(instructionContext.instructionBytes / 1024)}KB (agent prompt + env + git + memory)`
);
console.log(`[MCP] Tool profile: ${getChatGptToolProfile()} (CHATGPT_TOOL_PROFILE)`);

const sessionManager = createSessionManager({
  workspaceRoot,
  defaultShellCwd,
  shellTimeout: SHELL_TIMEOUT,
  workspaceRoots,
  projects: projectRegistry.projects,
  port: PORT,
  primaryProjectId: primaryProject?.id ?? null,
  defaultProjectInstruction: projectRegistry.default_project_instruction,
  pid: process.pid,
  adminPort: ADMIN_PORT,
  projectMemoryInstructions: instructionContext.instructionsText,
});

const MCP_TOKENS = [...new Set([MCP_TOKEN, MCP_TOKEN_NEXT].filter(Boolean))];
const MCP_PATHS = MCP_TOKENS.length > 0
  ? MCP_TOKENS.flatMap((token) => [`/${token}`, `/mcp/${token}`])
  : ["/", "/mcp"];
const MCP_PATHS_SET = new Set(MCP_PATHS);

function redactRequestUrl(rawUrl: string): string {
  const queryIndex = rawUrl.indexOf("?");
  const pathname = queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;
  if (!MCP_PATHS_SET.has(pathname)) return rawUrl;
  return pathname.startsWith("/mcp/") ? "/mcp/<redacted>" : "/<redacted>";
}

const app = express();
app.use(cors());

// Log every incoming request details for debugging Gemini connection
app.use((req, _res, next) => {
  console.log(`[INCOMING] ${req.method} ${redactRequestUrl(req.originalUrl)} | Content-Type: ${req.headers["content-type"]} | Accept: ${req.headers["accept"]} | Auth: ${req.headers["authorization"] ? "Bearer ***" : "none"}`);
  next();
});

// Normalize Accept header for MCP Streamable HTTP SDK compatibility
// (SDK requires both application/json and text/event-stream in Accept header)
app.use((req, _res, next) => {
  const targetAccept = "application/json, text/event-stream, */*";
  req.headers["accept"] = targetAccept;

  if (Array.isArray(req.rawHeaders)) {
    let found = false;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === "accept") {
        req.rawHeaders[i + 1] = targetAccept;
        found = true;
      }
    }
    if (!found) {
      req.rawHeaders.push("Accept", targetAccept);
    }
  }
  next();
});

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

// OAuth 2.1 shim — Claude Web & Gemini Spark connector handshake
// (/.well-known/*, /oauth/* — does not affect ChatGPT MCP traffic)
app.use(createOAuthShimRouter());

// ChatGPT co the goi "/" hoac "/mcp" — ho tro ca hai.
// Neu dat MCP_TOKEN/MCP_TOKEN_NEXT, endpoint doi thanh "/<token>" + "/mcp/<token>" va cac path
// khong co token se tra 401 (chong scan tunnel URL / trang web goi vao localhost).
app.use((req, res, next) => {
  const started = Date.now();
  const isMcpRoute = MCP_PATHS_SET.has(req.path);
  res.on("finish", () => {
    const duration = Date.now() - started;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const sessionInfo = sessionId ? ` session=${String(sessionId).slice(0, 8)}...` : "";

    if (req.method === "POST" && isMcpRoute) {
      const transportError =
        consumeSessionTransportError(sessionId) ||
        (typeof res.locals.mcpError === "string" ? res.locals.mcpError : undefined);
      logMcpRequest(req.body, sessionId, duration, res.statusCode, transportError);
      return;
    }

    if (isMcpRoute && res.statusCode >= 400) {
      const reason =
        (typeof res.locals.mcpError === "string" ? res.locals.mcpError : undefined) ||
        (res.statusCode === 404
          ? "Session not found"
          : res.statusCode === 400
            ? "Bad Request (missing Mcp-Session-Id or invalid state)"
            : `HTTP ${res.statusCode}`);
      logMcpHttpEvent({
        method: req.method,
        path: redactRequestUrl(req.path),
        httpStatus: res.statusCode,
        durationMs: duration,
        sessionId,
        errorMessage: reason,
      });
      return;
    }

    if (!isMcpRoute) {
      console.log(`[HTTP] ${req.method} ${req.path} ${res.statusCode} ${duration}ms${sessionInfo}`);
    }
  });
  next();
});

if (MCP_TOKENS.length > 0) {
  // 404 chu KHONG phai 401: theo chuan MCP, 401 la tin hieu "can OAuth" — client
  // (ChatGPT) se di tim OAuth metadata, khong thay, roi treo. 404 = khong co gi o day.
  for (const unguarded of ["/", "/mcp"]) {
    app.all(unguarded, (_req, res) => {
      res.status(404).json({ ok: false, error: "Not found" });
    });
  }
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    name: "codex-mcp-server",
  });
});

async function handleMcpPost(req: express.Request, res: express.Response): Promise<void> {
  try {
    const querySessionId =
      (req.query.sessionId as string) ||
      (req.query["mcp-session-id"] as string) ||
      (req.query.session_id as string);
    const sessionId = (req.headers["mcp-session-id"] as string | undefined) || querySessionId;
    const requestId = extractRequestId(req.body);
    console.log(`[MCP POST BODY] session=${sessionId || "none"}`, JSON.stringify(req.body));

    const existing = sessionId ? sessionManager.get(sessionId) : undefined;
    if (existing) {
      await sessionManager.handleExisting(existing, req, res, req.body);
      return;
    }

    if (isInitializeRequest(req.body)) {
      if (sessionId) {
        console.log(`[MCP] Re-initialize with stale session header: ${sessionId}`);
      }
      await sessionManager.createNew(req, res, req.body);
      return;
    }

    if (sessionId) {
      if (SESSION_RECOVERY) {
        const recovered = await sessionManager.tryRecoverStale(
          sessionId,
          req,
          res,
          req.body
        );
        if (recovered) return;
      }
      sessionManager.sendSessionNotFound(res, requestId);
      return;
    }

    // ChatGPT gui mot so request (vd "server/discover") KHONG kem Mcp-Session-Id.
    // Tra 400 o day khien connector retry vo han ("loading mai"). Thay vao do tao
    // session moi + warm-up roi phuc vu request, de SDK tra loi JSON-RPC hop le.
    if (SESSION_RECOVERY) {
      const adopted = await sessionManager.tryRecoverStale(
        randomUUID(),
        req,
        res,
        req.body
      );
      if (adopted) return;
    }

    sessionManager.sendBadRequest(
      res,
      "Bad Request: Mcp-Session-Id header is required",
      requestId
    );
  } catch (error) {
    console.log("[MCP] Error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: extractRequestId(req.body),
      });
    }
  }
}

function handleStaleSession(
  req: express.Request,
  res: express.Response,
  sessionId: string | undefined
): boolean {
  if (!sessionId || sessionManager.get(sessionId)) {
    return false;
  }
  sessionManager.sendSessionNotFound(res);
  return true;
}

async function handleMcpGet(req: express.Request, res: express.Response): Promise<void> {
  // Prevent proxies (Caddy, Cloudflare, etc.) from buffering or timing out SSE stream
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const querySessionId =
    (req.query.sessionId as string) ||
    (req.query["mcp-session-id"] as string) ||
    (req.query.session_id as string);
  const headerSessionId = req.headers["mcp-session-id"] as string | undefined;

  let sessionId = headerSessionId || querySessionId;

  if (!sessionId) {
    const recent = sessionManager.getMostRecent();
    if (recent && recent.transport.sessionId && Date.now() - recent.lastAccessedAt < 60_000) {
      const sid = recent.transport.sessionId;
      console.log(`[MCP] Attaching GET SSE stream to recent session: ${sid}`);
      req.headers["mcp-session-id"] = sid;
      if (Array.isArray(req.rawHeaders)) {
        req.rawHeaders.push("Mcp-Session-Id", sid);
      }
      await sessionManager.handleExisting(recent, req, res, undefined);
      return;
    }

    res.status(200).json({ status: "ok", name: "codex-mcp-server", message: "Codex MCP Endpoint is running" });
    return;
  }

  if (handleStaleSession(req, res, sessionId)) return;

  const session = sessionManager.get(sessionId);
  if (!session) {
    sessionManager.sendSessionNotFound(res);
    return;
  }

  await sessionManager.handleExisting(session, req, res, undefined);
}

async function handleMcpDelete(req: express.Request, res: express.Response): Promise<void> {
  const querySessionId =
    (req.query.sessionId as string) ||
    (req.query["mcp-session-id"] as string) ||
    (req.query.session_id as string);
  const sessionId = (req.headers["mcp-session-id"] as string | undefined) || querySessionId;

  if (handleStaleSession(req, res, sessionId)) return;

  if (!sessionId) {
    sessionManager.sendBadRequest(res, "Bad Request: Mcp-Session-Id header is required");
    return;
  }

  const session = sessionManager.get(sessionId);
  if (!session) {
    sessionManager.sendSessionNotFound(res);
    return;
  }

  await sessionManager.handleExisting(session, req, res, undefined);
}

for (const mcpPath of MCP_PATHS) {
  app.head(mcpPath, (_req, res) => {
    res.status(200).end();
  });
  app.post(mcpPath, handleMcpPost);
  app.get(mcpPath, handleMcpGet);
  app.delete(mcpPath, handleMcpDelete);
}

sessionManager.startCleanup();

const adminServer = startAdminServer({
  port: ADMIN_PORT,
  host: "127.0.0.1",
  mcpPort: PORT,
  pid: process.pid,
  manager: upstreamManager,
  sessionCount: () => sessionManager.count(),
  instructionSummary: () => summarizeInstructionContext(instructionContext),
  instructionsPreview: () => instructionContext.instructionsText,
});

const server = app.listen(PORT, HOST, () => {
  console.log("");
  console.log("========================================");
  console.log("  Codex MCP Server");
  console.log("========================================");
  console.log(`  Local:     http://${HOST}:${PORT}`);
  console.log(`  MCP:       http://${HOST}:${PORT}${MCP_TOKENS.length > 0 ? "/mcp/<redacted>" : "/mcp"}`);
  console.log(`  MCP tokens: ${MCP_TOKENS.length}`);
  console.log(`  Health:    http://${HOST}:${PORT}/health`);
  console.log(`  Admin UI:  http://127.0.0.1:${ADMIN_PORT}/ui`);
  console.log(`  Default cwd: ${defaultShellCwd}`);
  console.log(`  Full machine access: ON (no path restrictions)`);
  console.log(`  Session recovery: ${SESSION_RECOVERY ? "ON" : "OFF"}`);
  console.log(`  Auth:      ${MCP_TOKENS.length > 0 ? "ON (token in URL path)" : "OFF — dat MCP_TOKEN trong .env!"}`);
  console.log(`  OAuth shim:  ON (Claude Web & Gemini Spark compatible)`);
  console.log(`  PID:       ${process.pid}`);
  console.log("========================================");
  console.log("  Dang chay... (Ctrl+C de dung)");
  console.log("========================================");
  console.log("");
});

// Configure long-lived HTTP socket timeouts for SSE stability
server.keepAliveTimeout = 120_000; // 2 minutes
server.headersTimeout = 125_000;   // > keepAliveTimeout
server.requestTimeout = 0;         // disable request timeout for SSE streams

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n[LOI] Port ${PORT} da co server khac dang chay!`);
    console.error("Chay lenh sau de tim process:");
    console.error(`  netstat -ano | findstr ":${PORT}"`);
    console.error("Hoac dung: .\\stop.bat de tat server cu\n");
  } else {
    console.error("\n[LOI] Khong the khoi dong server:", err.message, "\n");
  }
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal: "SIGINT" | "SIGTERM"): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[DUNG] Server dang tat (${signal})...`);
  sessionManager.stopCleanup();
  stopContextEngineDiscovery();
  void upstreamManager.shutdown();
  adminServer.close();
  server.close(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Tranh process tu tat khi stdin dong (Windows + .bat)
if (process.stdin.isTTY) {
  process.stdin.resume();
}