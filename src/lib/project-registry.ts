import fs from "fs/promises";
import path from "path";
import { parse, stringify } from "smol-toml";

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  use_default_instruction: boolean;
  instruction: string;
  pinned_skills: string[];
}

export interface ProjectRegistryFile {
  version: 1;
  primary_project?: string;
  default_project_instruction: string;
  projects: ProjectConfig[];
}

const CONFIG_VERSION = 1 as const;

export function defaultProjectRegistry(): ProjectRegistryFile {
  return {
    version: CONFIG_VERSION,
    default_project_instruction: "",
    projects: [],
  };
}

export function resolveProjectRegistryPath(): string {
  return path.resolve(process.cwd(), "profiles", "projects.toml");
}

function requiredText(value: string, field: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function normalizeProject(project: ProjectConfig): ProjectConfig {
  const pinnedSkills = (project.pinned_skills ?? []).map((skill) =>
    requiredText(skill, "Pinned skill")
  );

  return {
    id: requiredText(project.id, "Project id"),
    name: requiredText(project.name, "Project name"),
    path: path.resolve(requiredText(project.path, "Project path")),
    use_default_instruction: project.use_default_instruction !== false,
    instruction: project.instruction ?? "",
    pinned_skills: [...new Set(pinnedSkills)],
  };
}

export function validateProjectRegistry(registry: ProjectRegistryFile): ProjectRegistryFile {
  if (registry?.version !== CONFIG_VERSION || !Array.isArray(registry.projects)) {
    throw new Error("Project registry must be version 1 with a projects array");
  }

  const projects = registry.projects.map(normalizeProject);
  const ids = new Set<string>();
  const paths = new Set<string>();

  for (const project of projects) {
    if (ids.has(project.id)) throw new Error(`Duplicate project id: ${project.id}`);
    if (paths.has(project.path)) throw new Error(`Duplicate project path: ${project.path}`);
    ids.add(project.id);
    paths.add(project.path);
  }

  const primaryProject =
    typeof registry.primary_project === "string" && registry.primary_project.trim()
      ? registry.primary_project.trim()
      : undefined;

  return {
    version: CONFIG_VERSION,
    ...(primaryProject ? { primary_project: primaryProject } : {}),
    default_project_instruction:
      typeof registry.default_project_instruction === "string"
        ? registry.default_project_instruction
        : "",
    projects,
  };
}

export async function loadProjectRegistry(
  configPath = resolveProjectRegistryPath()
): Promise<ProjectRegistryFile> {
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = parse(raw, { unsafeKeyBehaviour: "throw" }) as unknown as ProjectRegistryFile;
    return validateProjectRegistry(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultProjectRegistry();
    }
    throw error;
  }
}

export async function saveProjectRegistry(
  registry: ProjectRegistryFile,
  configPath = resolveProjectRegistryPath()
): Promise<void> {
  const normalized = validateProjectRegistry(registry);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, stringify(normalized), "utf-8");
}

async function projectRegistryFileExists(configPath: string): Promise<boolean> {
  try {
    await fs.access(configPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function resolvePrimaryProject(
  registry: ProjectRegistryFile
): ProjectConfig | null {
  const normalized = validateProjectRegistry(registry);
  if (normalized.projects.length === 0) return null;

  return (
    normalized.projects.find((project) => project.id === normalized.primary_project) ??
    normalized.projects[0]
  );
}

function splitWorkspacePaths(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(";")
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
}

function projectId(projectPath: string, usedIds: Set<string>): string {
  const base =
    path.basename(projectPath)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";

  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) id = `${base}-${suffix++}`;
  usedIds.add(id);
  return id;
}

export function createProjectConfig(
  registry: ProjectRegistryFile,
  input: {
    name: string;
    path: string;
    use_default_instruction?: boolean;
    instruction?: string;
    pinned_skills?: string[];
  }
): ProjectConfig {
  const projectPath = path.resolve(requiredText(input.path, "Project path"));
  const usedIds = new Set(registry.projects.map((project) => project.id));
  return normalizeProject({
    id: projectId(projectPath, usedIds),
    name: requiredText(input.name, "Project name"),
    path: projectPath,
    use_default_instruction: input.use_default_instruction !== false,
    instruction: input.instruction ?? "",
    pinned_skills: input.pinned_skills ?? [],
  });
}

export function bootstrapLegacyProjects(env: NodeJS.ProcessEnv): ProjectRegistryFile {
  const paths = [
    ...splitWorkspacePaths(env.WORKSPACE_PATH),
    ...splitWorkspacePaths(env.EXTRA_WORKSPACE_PATHS),
    ...splitWorkspacePaths(env.WORKSPACE_PATHS),
    ...splitWorkspacePaths(env.ALLOWED_WORKSPACE_PATHS),
  ];

  const usedIds = new Set<string>();
  const projects = [...new Set(paths)].map((projectPath) => ({
    id: projectId(projectPath, usedIds),
    name: path.basename(projectPath) || projectPath,
    path: projectPath,
    use_default_instruction: true,
    instruction: "",
    pinned_skills: [],
  }));

  return {
    version: CONFIG_VERSION,
    ...(projects.length ? { primary_project: projects[0].id } : {}),
    default_project_instruction: "",
    projects,
  };
}

export async function loadOrBootstrapProjectRegistry(
  env: NodeJS.ProcessEnv = process.env,
  configPath = resolveProjectRegistryPath()
): Promise<ProjectRegistryFile> {
  if (await projectRegistryFileExists(configPath)) {
    return loadProjectRegistry(configPath);
  }

  const bootstrapped = bootstrapLegacyProjects(env);
  if (bootstrapped.projects.length === 0) {
    return bootstrapped;
  }

  await saveProjectRegistry(bootstrapped, configPath);
  return loadProjectRegistry(configPath);
}
