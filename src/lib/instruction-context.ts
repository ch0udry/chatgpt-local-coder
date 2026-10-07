import { CODEX_AGENT_PROMPT } from "./codex-agent-prompt.js";
import {
  collectGitSnapshot,
  formatEnvironmentForInstructions,
  formatGitSnapshotForInstructions,
  type GitSnapshot,
} from "./git-snapshot.js";
import {
  formatProjectMemoryForInstructions,
  loadProjectMemory,
  type ProjectMemoryBundle,
} from "./project-memory.js";
import { appendAutoMemory, formatAutoMemoryForInstructions, loadAutoMemory } from "./auto-memory.js";
import { formatSkillsForInstructions, loadProjectSkills } from "./skills-loader.js";
import { getChatGptToolProfile } from "./tool-profile.js";
import { buildServerInstructions } from "./quickstart.js";
import type { ProjectRuntimeState } from "./project-registry.js";

export interface InstructionContextOptions {
  workspaceRoot: string;
  workspaceRoots: string[];
  pid: number;
  adminPort: number;
  defaultProjectInstruction?: string;
  useDefaultProjectInstruction?: boolean;
  projectInstruction?: string;
}

export interface InstructionContext {
  projectMemory: ProjectMemoryBundle;
  git: GitSnapshot;
  instructionsText: string;
  instructionBytes: number;
}

export function buildStaticMcpInstructions(shellRoot: string): string {
  return [
    "# Codex Local Coder MCP",
    "Project selection is process-global and dynamic.",
    "Call runtime_context before connector task work; do not use list_projects merely to discover the default project.",
    `Shell root: ${shellRoot}`,
    "Full machine access: ON. Explicit absolute paths may target anywhere allowed by the OS/user account.",
    CODEX_AGENT_PROMPT,
  ].join("\n\n");
}

export async function buildRuntimeContext(
  runtime: ProjectRuntimeState,
  opts: {
    workspaceRoots: string[];
    pid: number;
    adminPort: number;
  }
): Promise<Record<string, unknown>> {
  const snapshot = runtime.snapshot();
  const base = {
    runtime_revision: snapshot.runtimeRevision,
    mode: snapshot.mode,
    active_project_id: snapshot.activeProject?.id ?? null,
    active_project_path: snapshot.activeProject?.path ?? null,
    effective_root: snapshot.effectiveRoot,
    shell_root: snapshot.shellRoot,
  };

  if (!snapshot.activeProject) {
    return {
      ...base,
      directive:
        "No project is active. Use the shell root for relative/default work. Do not infer or register the shell root as a project. This current global state supersedes any earlier connector project selection in the chat.",
      project_context: null,
    };
  }

  const project = snapshot.activeProject;
  const context = await buildInstructionContext({
    workspaceRoot: project.path,
    workspaceRoots: opts.workspaceRoots,
    pid: opts.pid,
    adminPort: opts.adminPort,
    defaultProjectInstruction: snapshot.registry.default_project_instruction,
    useDefaultProjectInstruction: project.use_default_instruction !== false,
    projectInstruction: project.instruction,
  });

  return {
    ...base,
    directive:
      "The active project below is the current global default for connector operations. Use it for relative project work unless the user explicitly supplies another absolute path. This current global state supersedes any earlier connector project selection in the chat.",
    project_context: {
      instructions: context.instructionsText,
      summary: summarizeInstructionContext(context),
    },
  };
}

export async function buildInstructionContext(
  opts: InstructionContextOptions
): Promise<InstructionContext> {
  const [projectMemory, git, skills, autoMemory] = await Promise.all([
    loadProjectMemory(opts.workspaceRoot, { workspaceRoots: opts.workspaceRoots }),
    collectGitSnapshot(opts.workspaceRoot),
    loadProjectSkills(opts.workspaceRoot),
    loadAutoMemory(opts.workspaceRoot),
  ]);

  const profile = getChatGptToolProfile();
  const defaultProjectInstruction =
    opts.useDefaultProjectInstruction !== false
      ? opts.defaultProjectInstruction?.trim()
      : "";
  const projectInstruction = opts.projectInstruction?.trim();

  const blocks = [
    CODEX_AGENT_PROMPT,
    `Tool profile: **${profile}** (${profile === "slim" ? "core tools only — optimal for ChatGPT web" : "all tools exposed"}).`,
    formatEnvironmentForInstructions({
      workspaceRoot: opts.workspaceRoot,
      workspaceRoots: opts.workspaceRoots,
      pid: opts.pid,
      adminPort: opts.adminPort,
      nodeVersion: process.version,
    }),
    defaultProjectInstruction
      ? `## Default project instruction\n${defaultProjectInstruction}`
      : "",
    projectInstruction
      ? `## Project instruction\n${projectInstruction}`
      : "",
    formatGitSnapshotForInstructions(git),
    formatAutoMemoryForInstructions(autoMemory),
    formatProjectMemoryForInstructions(projectMemory),
    formatSkillsForInstructions(skills),
  ].filter(Boolean);

  const projectMemoryBlock = blocks.join("\n\n");
  const instructionsText = buildServerInstructions(
    opts.workspaceRoot,
    opts.workspaceRoots,
    true,
    projectMemoryBlock
  );

  return {
    projectMemory,
    git,
    instructionsText,
    instructionBytes: Buffer.byteLength(instructionsText, "utf-8"),
  };
}

export function summarizeInstructionContext(ctx: InstructionContext): Record<string, unknown> {
  return {
    root: ctx.projectMemory.root,
    workspace_roots: ctx.projectMemory.workspace_roots,
    memory_files: ctx.projectMemory.sections.map((s) => ({
      path: s.path,
      kind: s.kind,
      truncated: s.truncated,
    })),
    memory_bytes: ctx.projectMemory.total_bytes,
    instruction_bytes: ctx.instructionBytes,
    git: ctx.git.is_repo
      ? { branch: ctx.git.branch, commits: ctx.git.recent_commits?.length ?? 0 }
      : { is_repo: false },
    loaded_at: ctx.projectMemory.loaded_at,
    tool_profile: getChatGptToolProfile(),
  };
}

export { appendAutoMemory };