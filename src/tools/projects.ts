import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolError, toolResult } from "../lib/tool-result.js";

export interface ProjectToolEntry {
  id: string;
  name: string;
  path: string;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function contextSummary(projectPath: string) {
  const [hasAgents, hasClaude, hasRules, hasSkills] = await Promise.all([
    exists(path.join(projectPath, "AGENTS.md")),
    exists(path.join(projectPath, "CLAUDE.md")),
    exists(path.join(projectPath, ".claude", "rules")),
    exists(path.join(projectPath, ".claude", "skills")),
  ]);
  return {
    has_agents: hasAgents,
    has_claude: hasClaude,
    has_rules: hasRules,
    has_skills: hasSkills,
  };
}

export function registerProjectTools(
  server: McpServer,
  getProjects: () => ProjectToolEntry[],
  getMode: () => "project" | "shell",
  getActiveProject: () => { id: string; root: string } | null,
  getRuntimeContext: () => Promise<Record<string, unknown>>
): void {
  server.registerTool(
    "runtime_context",
    {
      title: "Runtime Context",
      description:
        "Load the current global Project Mode or Shell Mode, effective root, and current project context. Call this before connector task work.",
      inputSchema: {},
      annotations: toolAnnotations("read"),
    },
    async () => toolResult("runtime_context", await getRuntimeContext())
  );

  server.registerTool(
    "list_projects",
    {
      title: "List Projects",
      description:
        "List registered projects and the one global active project, or Shell Mode when none is active.",
      inputSchema: {},
      annotations: toolAnnotations("read"),
    },
    async () => {
      const projects = getProjects();
      const activeId = getActiveProject()?.id ?? null;
      const rows = await Promise.all(projects.map(async (project) => ({
        ...project,
        active: project.id === activeId,
        context: await contextSummary(project.path),
      })));
      return toolResult("list_projects", {
        mode: getMode(),
        active_project_id: activeId,
        projects: rows,
        count: rows.length,
      });
    }
  );

  server.registerTool(
    "use_project",
    {
      title: "Use Project",
      description:
        "Project activation is global and controlled by the Admin UI. This compatibility tool does not change project state.",
      inputSchema: {
        project: z.string().min(1).describe("Exact registered project id or exact absolute path"),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ project: requested }) => {
      return toolError("use_project", "Project activation is global and controlled by the Admin UI.", {
        requested,
        mode: getMode(),
        active_project_id: getActiveProject()?.id ?? null,
      });
    }
  );
}
