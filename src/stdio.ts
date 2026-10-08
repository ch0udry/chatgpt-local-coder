#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server-factory.js";
import { setDefaultCwd } from "./lib/path-security.js";
import { initUpstreamManager } from "./lib/mcp-upstream-manager.js";
import { loadOrBootstrapProjectRegistry, ProjectRuntimeState } from "./lib/project-registry.js";
import { buildRuntimeContext, buildStaticMcpInstructions } from "./lib/instruction-context.js";

// STDIO reserves stdout exclusively for MCP JSON-RPC messages.
for (const level of ["log", "info", "warn", "debug"] as const) {
  console[level] = (...values: unknown[]) => console.error(...values);
}

async function main(): Promise<void> {
  const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  process.chdir(projectDir);
  dotenv.config({ path: path.join(projectDir, ".env") });

  const defaultShellCwd = path.resolve(process.env.DEFAULT_SHELL_CWD || projectDir);
  const runtime = new ProjectRuntimeState(
    await loadOrBootstrapProjectRegistry(process.env),
    defaultShellCwd
  );
  const workspaceRoots = runtime.getProjects().map((project) => project.path);
  setDefaultCwd(defaultShellCwd);
  const upstream = await initUpstreamManager();
  const shellTimeout = parseInt(process.env.SHELL_TIMEOUT || "120", 10);
  const adminPort = parseInt(process.env.ADMIN_PORT || "3001", 10);
  const server = await createMcpServer(
    runtime.getEffectiveRoot(), shellTimeout, workspaceRoots, true, upstream,
    buildStaticMcpInstructions(defaultShellCwd),
    () => runtime.getEffectiveRoot(),
    () => runtime.getEffectiveRoot(),
    () => {
      const active = runtime.getActiveProject();
      return active ? { id: active.id, root: active.path } : null;
    },
    {
      getProjects: () => runtime.getProjects().map(({ id, name, path }) => ({ id, name, path })),
      getMode: () => runtime.getMode(),
      getRuntimeContext: () => buildRuntimeContext(runtime, {
        workspaceRoots, pid: process.pid, adminPort,
      }),
    },
    randomUUID(),
    () => [runtime.getMode(), runtime.getActiveProject()?.id ?? "", runtime.getEffectiveRoot()].join(":")
  );
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
