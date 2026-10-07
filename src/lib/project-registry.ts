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
  version: 2;
  active_project?: string;
  default_project_instruction: string;
  projects: ProjectConfig[];
  /**
   * Transitional compile compatibility for PWS-020 Admin cleanup.
   * Never persisted or used by v2 runtime semantics.
   */
  primary_project?: string;
}

interface LegacyProjectRegistryFile {
  version: 1;
  primary_project?: string;
  default_project_instruction?: string;
  projects: ProjectConfig[];
}

export interface ProjectRuntimeSnapshot {
  registry: ProjectRegistryFile;
  mode: "project" | "shell";
  activeProject: ProjectConfig | null;
  effectiveRoot: string;
  shellRoot: string;
  runtimeRevision: number;
}

const CONFIG_VERSION = 2 as const;

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

function normalizedProjects(projects: ProjectConfig[]): ProjectConfig[] {
  const normalized = projects.map(normalizeProject);
  const ids = new Set<string>();
  const paths = new Set<string>();

  for (const project of normalized) {
    if (ids.has(project.id)) throw new Error(`Duplicate project id: ${project.id}`);
    if (paths.has(project.path)) throw new Error(`Duplicate project path: ${project.path}`);
    ids.add(project.id);
    paths.add(project.path);
  }

  return normalized;
}

export function validateProjectRegistry(registry: ProjectRegistryFile): ProjectRegistryFile {
  if (registry?.version !== CONFIG_VERSION || !Array.isArray(registry.projects)) {
    throw new Error("Project registry must be version 2 with a projects array");
  }

  const projects = normalizedProjects(registry.projects);
  const activeProject =
    typeof registry.active_project === "string" && registry.active_project.trim()
      ? registry.active_project.trim()
      : undefined;

  if (activeProject && !projects.some((project) => project.id === activeProject)) {
    throw new Error(`Active project is not registered: ${activeProject}`);
  }

  return {
    version: CONFIG_VERSION,
    ...(activeProject ? { active_project: activeProject } : {}),
    default_project_instruction:
      typeof registry.default_project_instruction === "string"
        ? registry.default_project_instruction
        : "",
    projects,
  };
}

function migrateLegacyRegistry(registry: LegacyProjectRegistryFile): ProjectRegistryFile {
  if (!Array.isArray(registry.projects)) {
    throw new Error("Legacy project registry must contain a projects array");
  }

  const projects = normalizedProjects(registry.projects);
  const requested =
    typeof registry.primary_project === "string" && registry.primary_project.trim()
      ? registry.primary_project.trim()
      : undefined;
  const activeProject = requested && projects.some((project) => project.id === requested)
    ? requested
    : undefined;

  if (requested && !activeProject) {
    console.warn(
      `[projects] Legacy primary_project "${requested}" is not registered; migrating to Shell Mode.`
    );
  }

  return {
    version: CONFIG_VERSION,
    ...(activeProject ? { active_project: activeProject } : {}),
    default_project_instruction:
      typeof registry.default_project_instruction === "string"
        ? registry.default_project_instruction
        : "",
    projects,
  };
}

async function writeV1BackupOnce(configPath: string, raw: string): Promise<void> {
  try {
    await fs.writeFile(`${configPath}.v1.bak`, raw, { encoding: "utf-8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export async function loadProjectRegistry(
  configPath = resolveProjectRegistryPath()
): Promise<ProjectRegistryFile> {
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = parse(raw, { unsafeKeyBehaviour: "throw" }) as unknown as
      | ProjectRegistryFile
      | LegacyProjectRegistryFile;

    if (parsed?.version === 1) {
      const migrated = migrateLegacyRegistry(parsed as LegacyProjectRegistryFile);
      await writeV1BackupOnce(configPath, raw);
      await saveProjectRegistry(migrated, configPath);
      return migrated;
    }

    return validateProjectRegistry(parsed as ProjectRegistryFile);
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
  const tempPath = `${configPath}.tmp-${process.pid}`;
  try {
    await fs.writeFile(tempPath, stringify(normalized), "utf-8");
    await fs.rename(tempPath, configPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function resolveActiveProject(
  registry: ProjectRegistryFile
): ProjectConfig | null {
  const normalized = validateProjectRegistry(registry);
  if (!normalized.active_project) return null;
  return normalized.projects.find((project) => project.id === normalized.active_project) ?? null;
}

/** @deprecated PWS-020 removes primary terminology from Admin/API. */
export function resolvePrimaryProject(
  registry: ProjectRegistryFile
): ProjectConfig | null {
  return resolveActiveProject(registry);
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

/**
 * Transitional name retained until PWS-020/PWS-021 cleanup.
 * v2 intentionally ignores legacy workspace env values.
 */
export async function loadOrBootstrapProjectRegistry(
  _env: NodeJS.ProcessEnv = process.env,
  configPath = resolveProjectRegistryPath()
): Promise<ProjectRegistryFile> {
  return loadProjectRegistry(configPath);
}

function cloneRegistry(registry: ProjectRegistryFile): ProjectRegistryFile {
  return {
    version: CONFIG_VERSION,
    ...(registry.active_project ? { active_project: registry.active_project } : {}),
    default_project_instruction: registry.default_project_instruction,
    projects: registry.projects.map((project) => ({
      ...project,
      pinned_skills: [...project.pinned_skills],
    })),
  };
}

export class ProjectRuntimeState {
  private registry: ProjectRegistryFile;
  private readonly shellRoot: string;
  private readonly configPath: string;
  private runtimeRevision = 1;
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(
    registry: ProjectRegistryFile,
    shellRoot: string,
    configPath = resolveProjectRegistryPath()
  ) {
    this.registry = validateProjectRegistry(registry);
    this.shellRoot = path.resolve(shellRoot);
    this.configPath = configPath;
  }

  snapshot(): ProjectRuntimeSnapshot {
    const registry = cloneRegistry(this.registry);
    const activeProject = resolveActiveProject(registry);
    return {
      registry,
      mode: activeProject ? "project" : "shell",
      activeProject,
      effectiveRoot: activeProject?.path ?? this.shellRoot,
      shellRoot: this.shellRoot,
      runtimeRevision: this.runtimeRevision,
    };
  }

  getRegistry(): ProjectRegistryFile {
    return this.snapshot().registry;
  }

  getProjects(): ProjectConfig[] {
    return this.getRegistry().projects;
  }

  getActiveProject(): ProjectConfig | null {
    return this.snapshot().activeProject;
  }

  getMode(): "project" | "shell" {
    return this.getActiveProject() ? "project" : "shell";
  }

  getEffectiveRoot(): string {
    return this.getActiveProject()?.path ?? this.shellRoot;
  }

  getShellRoot(): string {
    return this.shellRoot;
  }

  getRuntimeRevision(): number {
    return this.runtimeRevision;
  }

  async replaceRegistry(next: ProjectRegistryFile): Promise<ProjectRuntimeSnapshot> {
    let result!: ProjectRuntimeSnapshot;
    const operation = this.mutationChain.then(async () => {
      const normalized = validateProjectRegistry(next);
      await saveProjectRegistry(normalized, this.configPath);
      const changed = JSON.stringify(normalized) !== JSON.stringify(this.registry);
      this.registry = normalized;
      if (changed) this.runtimeRevision++;
      result = this.snapshot();
    });
    this.mutationChain = operation.then(() => undefined, () => undefined);
    await operation;
    return result;
  }

  async activateProject(projectId: string): Promise<ProjectRuntimeSnapshot> {
    const requested = requiredText(projectId, "Project id");
    if (!this.registry.projects.some((project) => project.id === requested)) {
      throw new Error(`Active project is not registered: ${requested}`);
    }
    return this.replaceRegistry({
      ...this.getRegistry(),
      active_project: requested,
    });
  }

  async useShellMode(): Promise<ProjectRuntimeSnapshot> {
    const next = this.getRegistry();
    delete next.active_project;
    return this.replaceRegistry(next);
  }
}
