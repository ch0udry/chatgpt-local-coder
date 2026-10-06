import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  listAvailableSkills,
  resolveSkill,
  type ActiveProjectSkillContext,
} from "../lib/skills-loader.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolError, toolResult } from "../lib/tool-result.js";

export function registerSkillTools(
  server: McpServer,
  getActiveProject: () => ActiveProjectSkillContext | null
): void {
  server.registerTool(
    "list_skills",
    {
      title: "List Skills",
      description:
        "List skills available now. Active-project skills take precedence over same-name global skills.",
      inputSchema: {},
      annotations: toolAnnotations("read"),
    },
    async () => {
      const activeProject = getActiveProject();
      const skills = await listAvailableSkills(activeProject);
      return toolResult("list_skills", {
        active_project_id: activeProject?.id ?? null,
        skills,
        count: skills.length,
      });
    }
  );

  server.registerTool(
    "load_skill",
    {
      title: "Load Skill",
      description:
        "Load the full SKILL.md for a named skill. Resolves active project first, then global skills. Unique prefixes are accepted; ambiguous names return candidates.",
      inputSchema: {
        name: z.string().min(1).describe("Skill name or unique deterministic alias"),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ name }) => {
      const activeProject = getActiveProject();
      const resolved = await resolveSkill(name, activeProject);

      if (resolved.status === "ambiguous") {
        return toolError("load_skill", `Ambiguous skill alias: ${name}`, {
          requested: name,
          candidates: resolved.candidates,
        });
      }
      if (resolved.status === "not_found") {
        return toolError("load_skill", `Skill not found: ${name}`, {
          requested: name,
          candidates: resolved.candidates,
        });
      }

      return toolResult("load_skill", {
        name: resolved.skill.name,
        source: resolved.skill.source,
        path: resolved.skill.path,
        project_id: resolved.skill.project_id ?? null,
        description: resolved.skill.description,
        content: resolved.skill.content,
      });
    }
  );
}
