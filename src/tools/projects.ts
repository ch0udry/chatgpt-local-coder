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

function resolveProject(
  projects: ProjectToolEntry[],
  requested: string
): { project?: ProjectToolEntry; candidates?: ProjectToolEntry[] } {
  const query = requested.trim();
  const byId = projects.find((project) => project.id === query);
  if (byId) return { project: byId };

  if (path.isAbsolute(query)) {
    const resolved = path.resolve(query);
    const byPath = projects.find((project) => path.resolve(project.path) === resolved);
    if (byPath) return { project: byPath };
  }

  const sameName = projects.filter((project) => project.name === query);
  if (sameName.length) return { candidates: sameName };
  return {};
}

export function registerProjectTools(
  server: McpServer,
  projects: ProjectToolEntry[],
  primaryProjectId: string | null,
  getActiveProject: () => { id: string; root: string } | null,
  setActiveProject: (projectId: string) => void,
  getProjectInstructions: (projectId: string, projectRoot: string) => Promise<string | undefined>
): void {
  server.registerTool(
    "list_projects",
    {
      title: "List Projects",
      description:
        "List registered projects, including the global primary project and this MCP session's active project.",
      inputSchema: {},
      annotations: toolAnnotations("read"),
    },
    async () => {
      const activeId = getActiveProject()?.id ?? null;
      const rows = await Promise.all(projects.map(async (project) => ({
        ...project,
        primary: project.id === primaryProjectId,
        active: project.id === activeId,
        context: await contextSummary(project.path),
      })));
      return toolResult("list_projects", {
        primary_project_id: primaryProjectId,
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
        "Select a registered project for this MCP session only. Resolve by exact project id or exact registered absolute path; project names are never guessed.",
      inputSchema: {
        project: z.string().min(1).describe("Exact registered project id or exact absolute path"),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ project: requested }) => {
      const resolved = resolveProject(projects, requested);
      if (!resolved.project) {
        const candidates = resolved.candidates ?? [];
        return toolError(
          "use_project",
          candidates.length
            ? `Project name is ambiguous or not selectable by name: ${requested}`
            : `Project not found: ${requested}`,
          {
            requested,
            candidates,
          }
        );
      }

      setActiveProject(resolved.project.id);
      const instructions = await getProjectInstructions(
        resolved.project.id,
        resolved.project.path
      );
      return toolResult("use_project", {
        project: {
          ...resolved.project,
          primary: resolved.project.id === primaryProjectId,
          active: true,
          context: await contextSummary(resolved.project.path),
        },
        instructions: instructions ?? "",
      });
    }
  );
}
