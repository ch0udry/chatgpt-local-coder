import fs from "fs/promises";
import path from "path";

export type SkillSource = "project" | "global";

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
  source?: SkillSource;
  project_id?: string;
}

export interface ActiveProjectSkillContext {
  id: string;
  root: string;
}

export interface ResolvedSkill extends SkillSummary {
  source: SkillSource;
  content: string;
}

export type SkillResolution =
  | { status: "found"; skill: ResolvedSkill }
  | { status: "ambiguous"; candidates: SkillSummary[] }
  | { status: "not_found"; candidates: SkillSummary[] };

function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const block = match[1];
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return { name, description };
}

function normalizeSkillName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

async function scanSkillDir(
  dir: string,
  source: SkillSource,
  projectId?: string,
  depth = 0
): Promise<SkillSummary[]> {
  if (depth > 3) return [];

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: SkillSummary[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;

    const full = path.join(dir, entry.name);
    const skillFile = path.join(full, "SKILL.md");
    try {
      const content = await fs.readFile(skillFile, "utf-8");
      const fm = parseFrontmatter(content);
      const name = fm.name || entry.name;
      const description =
        fm.description ||
        content.split("\n").find((line) => line.trim() && !line.startsWith("#"))?.trim() ||
        name;
      out.push({
        name,
        description: description.slice(0, 200),
        path: skillFile,
        source,
        ...(projectId ? { project_id: projectId } : {}),
      });
    } catch {
      out.push(...await scanSkillDir(full, source, projectId, depth + 1));
    }
  }
  return out;
}

async function projectSkills(activeProject: ActiveProjectSkillContext | null): Promise<SkillSummary[]> {
  if (!activeProject) return [];
  return scanSkillDir(
    path.join(activeProject.root, ".claude", "skills"),
    "project",
    activeProject.id
  );
}

async function globalSkills(): Promise<SkillSummary[]> {
  const globalSkillsDir = process.env.CHATGPT_GLOBAL_SKILLS_DIR?.trim();
  if (!globalSkillsDir) return [];
  return scanSkillDir(path.resolve(globalSkillsDir), "global");
}

export async function listAvailableSkills(
  activeProject: ActiveProjectSkillContext | null
): Promise<SkillSummary[]> {
  const [project, global] = await Promise.all([
    projectSkills(activeProject),
    globalSkills(),
  ]);

  const projectNames = new Set(project.map((skill) => normalizeSkillName(skill.name)));
  const effectiveGlobal = global.filter(
    (skill) => !projectNames.has(normalizeSkillName(skill.name))
  );

  return [...project, ...effectiveGlobal].sort((a, b) =>
    a.name.localeCompare(b.name) || (a.source || "").localeCompare(b.source || "")
  );
}

function tierMatches(skills: SkillSummary[], requested: string): SkillSummary[] {
  const wanted = normalizeSkillName(requested);
  const exact = skills.filter((skill) => normalizeSkillName(skill.name) === wanted);
  if (exact.length) return exact;

  return skills.filter((skill) => {
    const name = normalizeSkillName(skill.name);
    return name.startsWith(`${wanted}-`);
  });
}

export async function resolveSkill(
  requested: string,
  activeProject: ActiveProjectSkillContext | null
): Promise<SkillResolution> {
  const query = requested.trim();
  if (!query) return { status: "not_found", candidates: [] };

  const project = await projectSkills(activeProject);
  const projectMatches = tierMatches(project, query);
  if (projectMatches.length > 1) {
    return { status: "ambiguous", candidates: projectMatches };
  }
  if (projectMatches.length === 1) {
    const match = projectMatches[0];
    return {
      status: "found",
      skill: {
        ...match,
        source: "project",
        content: await fs.readFile(match.path, "utf-8"),
      },
    };
  }

  const global = await globalSkills();
  const globalMatches = tierMatches(global, query);
  if (globalMatches.length > 1) {
    return { status: "ambiguous", candidates: globalMatches };
  }
  if (globalMatches.length === 1) {
    const match = globalMatches[0];
    return {
      status: "found",
      skill: {
        ...match,
        source: "global",
        content: await fs.readFile(match.path, "utf-8"),
      },
    };
  }

  return { status: "not_found", candidates: [] };
}

export async function loadProjectSkills(workspaceRoot: string): Promise<SkillSummary[]> {
  return listAvailableSkills({ id: path.basename(workspaceRoot) || "project", root: workspaceRoot });
}

export function formatSkillsForInstructions(skills: SkillSummary[]): string {
  if (!skills.length) return "";
  return [
    "## Skills",
    "When the user names a skill, call load_skill before task work and follow the returned SKILL.md.",
    ...skills.map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n");
}
