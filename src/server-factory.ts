import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFilesystemTools } from "./tools/filesystem.js";
import { registerShellTools } from "./tools/shell.js";
import { registerGitTools } from "./tools/git.js";
import { registerContextTools } from "./tools/context.js";
import { registerRewindTools } from "./tools/rewind.js";
import { registerMcpBridgeTools } from "./tools/mcp-bridge.js";
import { registerSkillTools } from "./tools/skills.js";
import { registerProjectTools, type ProjectToolEntry } from "./tools/projects.js";
import { buildServerInstructions } from "./lib/quickstart.js";
import type { McpUpstreamManager } from "./lib/mcp-upstream-manager.js";
import { refreshProxiedTools } from "./lib/mcp-tool-proxy.js";
import { getChatGptToolProfile, shouldExposeTool } from "./lib/tool-profile.js";

const NOOP_TOOL = {
  remove: () => {},
  update: () => {},
  enable: () => {},
  disable: () => {},
  handler: async () => ({ content: [] }),
  enabled: false,
} as unknown as RegisteredTool;

function applyToolProfile(server: McpServer): void {
  const profile = getChatGptToolProfile();
  if (profile === "full") return;

  const original = server.registerTool.bind(server);
  server.registerTool = ((name, ...rest) => {
    if (!shouldExposeTool(String(name), profile)) return NOOP_TOOL;
    return original(name, ...rest);
  }) as typeof server.registerTool;
}

export async function createMcpServer(
  workspaceRoot: string,
  shellTimeout: number,
  workspaceRoots: string[] = [workspaceRoot],
  fullDiskAccess = false,
  upstreamManager?: McpUpstreamManager,
  projectMemoryInstructions?: string,
  getProjectRoot: () => string = () => workspaceRoot,
  getShellDefaultCwd: () => string = getProjectRoot,
  getActiveProject: () => { id: string; root: string } | null = () => ({
    id: "project",
    root: getProjectRoot(),
  }),
  projectRuntime?: {
    getProjects: () => ProjectToolEntry[];
    getMode: () => "project" | "shell";
    getRuntimeContext: () => Promise<Record<string, unknown>>;
  },
  shellSessionId = "standalone",
  getShellContextKey: () => string = () => getShellDefaultCwd()
): Promise<McpServer> {
  const server = new McpServer(
    {
      name: "codex-mcp-server",
      version: "2.0.0",
    },
    {
      instructions: projectMemoryInstructions,
      capabilities: {
        logging: {},
        tools: { listChanged: true },
      },
    }
  );

  applyToolProfile(server);

  registerFilesystemTools(server, getProjectRoot);
  registerShellTools(server, getShellDefaultCwd, shellTimeout, shellSessionId, getShellContextKey);
  registerGitTools(server, getProjectRoot);
  registerContextTools(server, getProjectRoot);
  registerSkillTools(server, getActiveProject);
  registerProjectTools(
    server,
    projectRuntime?.getProjects ?? (() => []),
    projectRuntime?.getMode ?? (() => getActiveProject() ? "project" : "shell"),
    getActiveProject,
    projectRuntime?.getRuntimeContext ?? (async () => ({
      mode: getActiveProject() ? "project" : "shell",
      active_project_id: getActiveProject()?.id ?? null,
    }))
  );
  registerRewindTools(server);

  if (upstreamManager) {
    registerMcpBridgeTools(server, upstreamManager);
    upstreamManager.registerMcpServer(server);
    await refreshProxiedTools(server, upstreamManager);
  }

  return server;
}
