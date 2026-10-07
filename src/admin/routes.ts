import fs from "fs/promises";
import path from "path";
import { Router, type Request, type Response } from "express";
import type { McpUpstreamManager } from "../lib/mcp-upstream-manager.js";
import {
  defaultUpstreamConfig,
  discoverMcpConfigs,
  findMcpConfigForSource,
  importMcpConfigFromFile,
  type McpImportSource,
  type UpstreamServerConfig,
} from "../lib/mcp-upstream-config.js";
import { getDefaultCwd, getFullDiskAccess } from "../lib/path-security.js";
import { getCheckpointConfig } from "../lib/checkpoint.js";
import {
  getRecentActivity,
  loadAuditHistory,
  subscribeActivity,
  type ActivityEntry,
} from "../lib/activity-log.js";
import {
  createProjectConfig,
  resolveProjectRegistryPath,
  type ProjectRuntimeState,
  type ProjectConfig,
} from "../lib/project-registry.js";
import { loadProjectMemory } from "../lib/project-memory.js";
import { listAvailableSkills } from "../lib/skills-loader.js";

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function requireProjectDirectory(projectPath: string): Promise<string> {
  const resolved = path.resolve(projectPath);
  try {
    const info = await fs.stat(resolved);
    if (!info.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`Project path is not an existing directory: ${resolved}`);
  }
  return resolved;
}

async function detectProjectContext(projectPath: string) {
  const [hasAgents, hasClaude, hasRules, hasSkills, hasGit] = await Promise.all([
    pathExists(path.join(projectPath, "AGENTS.md")),
    pathExists(path.join(projectPath, "CLAUDE.md")),
    pathExists(path.join(projectPath, ".claude", "rules")),
    pathExists(path.join(projectPath, ".claude", "skills")),
    pathExists(path.join(projectPath, ".git")),
  ]);
  return {
    has_agents: hasAgents,
    has_claude: hasClaude,
    has_rules: hasRules,
    has_skills: hasSkills,
    has_git: hasGit,
  };
}

async function projectResponse(activeProjectId: string | null, project: ProjectConfig) {
  return {
    ...project,
    active: activeProjectId === project.id,
    context: await detectProjectContext(project.path),
  };
}

function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    out[key] = value;
  }
  return out;
}

function serializeDotEnv(values: Record<string, string>, original: string): string {
  const lines = original.split("\n");
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      result.push(line);
      continue;
    }
    const key = trimmed.split("=")[0].trim();
    if (key in values) {
      result.push(`${key}=${values[key]}`);
      seen.add(key);
    } else {
      result.push(line);
    }
  }

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) result.push(`${key}=${value}`);
  }

  return result.join("\n");
}

export function createAdminRouter(manager: McpUpstreamManager, options: {
  mcpPort: number;
  pid: number;
  sessionCount: () => number;
  projectRuntime: ProjectRuntimeState;
  instructionSummary?: () => Record<string, unknown>;
  instructionsPreview?: () => string;
}): Router {
  const router = Router();
  const envPath = path.resolve(process.cwd(), ".env");
  const projectRegistryPath = resolveProjectRegistryPath();

  const registryError = (res: Response, err: unknown) => {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  };

  router.get("/api/projects", async (_req, res) => {
    try {
      const registry = options.projectRuntime.getRegistry();
      const activeProjectId = options.projectRuntime.getActiveProject()?.id ?? null;
      const projects = await Promise.all(
        registry.projects.map((project) => projectResponse(activeProjectId, project))
      );
      res.json({
        ok: true,
        mode: options.projectRuntime.getMode(),
        active_project_id: activeProjectId,
        effective_root: options.projectRuntime.getEffectiveRoot(),
        shell_root: options.projectRuntime.getShellRoot(),
        runtime_revision: options.projectRuntime.getRuntimeRevision(),
        projects,
      });
    } catch (err) {
      registryError(res, err);
    }
  });

  router.post("/api/projects", async (req, res) => {
    try {
      const registry = options.projectRuntime.getRegistry();
      const projectPath = await requireProjectDirectory(String(req.body?.path ?? ""));
      const project = createProjectConfig(registry, {
        name: String(req.body?.name ?? ""),
        path: projectPath,
        use_default_instruction: req.body?.use_default_instruction,
        instruction: req.body?.instruction,
        pinned_skills: req.body?.pinned_skills,
      });
      const next = { ...registry, projects: [...registry.projects, project] };
      const snapshot = await options.projectRuntime.replaceRegistry(next);
      res.json({
        ok: true,
        project: await projectResponse(snapshot.activeProject?.id ?? null, project),
        mode: snapshot.mode,
        active_project_id: snapshot.activeProject?.id ?? null,
        effective_root: snapshot.effectiveRoot,
        runtime_revision: snapshot.runtimeRevision,
      });
    } catch (err) {
      registryError(res, err);
    }
  });

  router.get("/api/projects/config", async (_req, res) => {
    try {
      const registry = options.projectRuntime.getRegistry();
      res.json({
        ok: true,
        path: projectRegistryPath,
        config: {
          default_project_instruction: registry.default_project_instruction,
        },
      });
    } catch (err) {
      registryError(res, err);
    }
  });

  router.put("/api/projects/config", async (req, res) => {
    try {
      const registry = options.projectRuntime.getRegistry();
      const body = req.body?.config ?? req.body ?? {};
      const next = {
        ...registry,
        default_project_instruction:
          body.default_project_instruction === undefined
            ? registry.default_project_instruction
            : String(body.default_project_instruction),
      };
      const snapshot = await options.projectRuntime.replaceRegistry(next);
      res.json({
        ok: true,
        config: {
          default_project_instruction: next.default_project_instruction,
        },
        mode: snapshot.mode,
        active_project_id: snapshot.activeProject?.id ?? null,
        effective_root: snapshot.effectiveRoot,
        runtime_revision: snapshot.runtimeRevision,
      });
    } catch (err) {
      registryError(res, err);
    }
  });

  router.put("/api/projects/shell", async (_req, res) => {
    try {
      const snapshot = await options.projectRuntime.useShellMode();
      res.json({
        ok: true,
        mode: snapshot.mode,
        active_project_id: null,
        effective_root: snapshot.effectiveRoot,
        shell_root: snapshot.shellRoot,
        runtime_revision: snapshot.runtimeRevision,
      });
    } catch (err) {
      registryError(res, err);
    }
  });

  router.get("/api/projects/:id", async (req, res) => {
    try {
      const registry = options.projectRuntime.getRegistry();
      const project = registry.projects.find((entry) => entry.id === req.params.id);
      if (!project) {
        res.status(404).json({ ok: false, error: "Project not found" });
        return;
      }
      res.json({
        ok: true,
        project: await projectResponse(options.projectRuntime.getActiveProject()?.id ?? null, project),
      });
    } catch (err) {
      registryError(res, err);
    }
  });

  router.put("/api/projects/:id", async (req, res) => {
    try {
      const registry = options.projectRuntime.getRegistry();
      const index = registry.projects.findIndex((entry) => entry.id === req.params.id);
      if (index < 0) {
        res.status(404).json({ ok: false, error: "Project not found" });
        return;
      }
      const current = registry.projects[index];
      const nextPath =
        req.body?.path === undefined
          ? current.path
          : await requireProjectDirectory(String(req.body.path));
      const updated: ProjectConfig = {
        ...current,
        name: req.body?.name === undefined ? current.name : String(req.body.name),
        path: nextPath,
        use_default_instruction:
          req.body?.use_default_instruction === undefined
            ? current.use_default_instruction
            : req.body.use_default_instruction !== false,
        instruction:
          req.body?.instruction === undefined ? current.instruction : String(req.body.instruction),
        pinned_skills:
          req.body?.pinned_skills === undefined
            ? current.pinned_skills
            : req.body.pinned_skills,
      };
      const projects = [...registry.projects];
      projects[index] = updated;
      const next = { ...registry, projects };
      const snapshot = await options.projectRuntime.replaceRegistry(next);
      const saved = snapshot.registry.projects.find((entry) => entry.id === req.params.id)!;
      res.json({
        ok: true,
        project: await projectResponse(snapshot.activeProject?.id ?? null, saved),
      });
    } catch (err) {
      registryError(res, err);
    }
  });

  router.delete("/api/projects/:id", async (req, res) => {
    try {
      const registry = options.projectRuntime.getRegistry();
      const removed = registry.projects.find((entry) => entry.id === req.params.id);
      if (!removed) {
        res.status(404).json({ ok: false, error: "Project not found" });
        return;
      }
      const projects = registry.projects.filter((entry) => entry.id !== req.params.id);
      const next = { ...registry, projects };
      if (next.active_project === removed.id) {
        delete next.active_project;
      }
      const snapshot = await options.projectRuntime.replaceRegistry(next);
      res.json({
        ok: true,
        removed_project_id: removed.id,
        files_deleted: false,
        mode: snapshot.mode,
        active_project_id: snapshot.activeProject?.id ?? null,
        effective_root: snapshot.effectiveRoot,
        runtime_revision: snapshot.runtimeRevision,
      });
    } catch (err) {
      registryError(res, err);
    }
  });

  router.put("/api/projects/:id/activate", async (req, res) => {
    try {
      if (!options.projectRuntime.getProjects().some((entry) => entry.id === req.params.id)) {
        res.status(404).json({ ok: false, error: "Project not found" });
        return;
      }
      const snapshot = await options.projectRuntime.activateProject(req.params.id);
      res.json({
        ok: true,
        mode: snapshot.mode,
        active_project_id: snapshot.activeProject?.id ?? null,
        effective_root: snapshot.effectiveRoot,
        shell_root: snapshot.shellRoot,
        runtime_revision: snapshot.runtimeRevision,
      });
    } catch (err) {
      registryError(res, err);
    }
  });

  router.get("/api/projects/:id/inspect", async (req, res) => {
    try {
      const registry = options.projectRuntime.getRegistry();
      const project = registry.projects.find((entry) => entry.id === req.params.id);
      if (!project) {
        res.status(404).json({ ok: false, error: "Project not found" });
        return;
      }
      const memory = await loadProjectMemory(project.path, {
        workspaceRoots: registry.projects.map((entry) => entry.path),
      });
      res.json({
        ok: true,
        project: await projectResponse(options.projectRuntime.getActiveProject()?.id ?? null, project),
        memory,
      });
    } catch (err) {
      registryError(res, err);
    }
  });

  router.get("/api/projects/:id/skills", async (req, res) => {
    try {
      const registry = options.projectRuntime.getRegistry();
      const project = registry.projects.find((entry) => entry.id === req.params.id);
      if (!project) {
        res.status(404).json({ ok: false, error: "Project not found" });
        return;
      }
      const [effective, globalSkills] = await Promise.all([
        listAvailableSkills({ id: project.id, root: project.path }),
        listAvailableSkills(null),
      ]);
      res.json({
        ok: true,
        project_id: project.id,
        project_skills: effective.filter((skill) => skill.source === "project"),
        global_skills: globalSkills,
        effective_skills: effective,
        pinned_skills: project.pinned_skills,
      });
    } catch (err) {
      registryError(res, err);
    }
  });

  router.get("/health", async (_req: Request, res: Response) => {
    const upstream = await manager.listStatuses();
    const snapshot = options.projectRuntime.snapshot();
    res.json({
      status: "ok",
      name: "codex-mcp-admin",
      pid: options.pid,
      mcp_port: options.mcpPort,
      active_sessions: options.sessionCount(),
      mode: snapshot.mode,
      active_project_id: snapshot.activeProject?.id ?? null,
      effective_root: snapshot.effectiveRoot,
      shell_root: snapshot.shellRoot,
      runtime_revision: snapshot.runtimeRevision,
      default_cwd: snapshot.effectiveRoot,
      full_disk_access: getFullDiskAccess(),
      upstream,
      checkpoint: getCheckpointConfig(),
      instructions: options.instructionSummary?.() ?? null,
    });
  });

  router.get("/api/instructions/preview", (_req, res) => {
    const text = options.instructionsPreview?.() ?? "";
    const summary = options.instructionSummary?.() ?? {};
    res.json({
      ok: true,
      summary,
      preview: text.slice(0, 12000),
      truncated: text.length > 12000,
      total_chars: text.length,
    });
  });

  router.get("/api/config/env", async (_req, res) => {
    try {
      const text = await fs.readFile(envPath, "utf-8");
      res.json({ ok: true, path: envPath, values: parseDotEnv(text) });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        res.json({ ok: true, path: envPath, values: {} });
        return;
      }
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.put("/api/config/env", async (req, res) => {
    try {
      const values = req.body?.values as Record<string, string>;
      if (!values || typeof values !== "object") {
        res.status(400).json({ ok: false, error: "values object required" });
        return;
      }
      let original = "";
      try {
        original = await fs.readFile(envPath, "utf-8");
      } catch {}
      const next = serializeDotEnv(values, original || "");
      await fs.writeFile(envPath, next, "utf-8");
      for (const [k, v] of Object.entries(values)) {
        process.env[k] = v;
      }
      res.json({ ok: true, path: envPath });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.get("/api/upstream", async (_req, res) => {
    res.json({ ok: true, config: manager.getConfig(), path: manager.getConfigPath() });
  });

  router.put("/api/upstream", async (req, res) => {
    try {
      const config = req.body?.config ?? defaultUpstreamConfig();
      const saved = await manager.updateConfig(config);
      res.json({ ok: true, config: saved });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/upstream", async (req, res) => {
    try {
      const server = req.body?.server as UpstreamServerConfig;
      if (!server?.id) {
        res.status(400).json({ ok: false, error: "server.id required" });
        return;
      }
      await manager.upsertServer(server);
      res.json({ ok: true, config: manager.getConfig() });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete("/api/upstream/:id", async (req, res) => {
    const removed = await manager.removeServer(req.params.id);
    if (!removed) {
      res.status(404).json({ ok: false, error: "not found" });
      return;
    }
    res.json({ ok: true, config: manager.getConfig() });
  });

  router.post("/api/upstream/:id/test", async (req, res) => {
    try {
      const status = await manager.checkHealth(req.params.id);
      res.json({ ok: status.health === "connected", status });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/upstream/:id/tools", async (req, res) => {
    try {
      const tools = await manager.listTools(req.params.id);
      const config = manager.getServerConfig(req.params.id);
      res.json({
        ok: true,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
        proxied_tools: config ? manager.getProxiedToolNames(config, tools) : [],
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/import/sources", async (_req, res) => {
    try {
      const sources = await discoverMcpConfigs();
      res.json({ ok: true, sources });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  async function handleImport(
    source: McpImportSource,
    body: { path?: string; merge?: boolean; enable?: boolean }
  ) {
    const configPath = body.path || (await findMcpConfigForSource(source));
    if (!configPath) throw new Error(`${source} MCP config not found on this machine`);
    return importMcpConfigFromFile(configPath, source, {
      merge: body.merge !== false,
      enableImported: Boolean(body.enable),
    });
  }

  router.post("/api/import/:source", async (req, res) => {
    try {
      const source = req.params.source as McpImportSource;
      if (!["cursor", "claude", "opencode", "file"].includes(source)) {
        res.status(400).json({ ok: false, error: "Unknown import source" });
        return;
      }
      const filePath = req.body?.path as string | undefined;
      if (source === "file" && !filePath) {
        res.status(400).json({ ok: false, error: "path required for file import" });
        return;
      }
      const detectSource: McpImportSource =
        source === "file" ? (req.body?.detect_as as McpImportSource) || "cursor" : source;
      const result = await importMcpConfigFromFile(filePath || (await findMcpConfigForSource(source))!, detectSource, {
        merge: req.body?.merge !== false,
        enableImported: Boolean(req.body?.enable),
      });
      await manager.reloadConfig();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/import/cursor", async (req, res) => {
    try {
      const result = await handleImport("cursor", req.body ?? {});
      await manager.reloadConfig();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  function filterActivity(
    entries: ActivityEntry[],
    opts: { kind?: string; status?: string; tool?: string; q?: string }
  ): ActivityEntry[] {
    let out = entries;
    if (opts.kind && opts.kind !== "all") {
      out = out.filter((e) => e.kind === opts.kind);
    }
    if (opts.status === "error") {
      out = out.filter((e) => e.status === "error" || e.status === "blocked");
    }
    if (opts.tool) {
      const needle = opts.tool.toLowerCase();
      out = out.filter((e) => e.tool?.toLowerCase().includes(needle));
    }
    if (opts.q) {
      const needle = opts.q.toLowerCase();
      out = out.filter((e) => {
        const hay = [e.tool, e.action, e.target, e.summary, e.client, e.session_id]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(needle);
      });
    }
    return out;
  }

  router.get("/api/activity", (req, res) => {
    const limit = Math.min(parseInt(String(req.query.limit || "100"), 10) || 100, 500);
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    const entries = filterActivity(getRecentActivity(limit, since), {
      kind: typeof req.query.kind === "string" ? req.query.kind : undefined,
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      tool: typeof req.query.tool === "string" ? req.query.tool : undefined,
      q: typeof req.query.q === "string" ? req.query.q : undefined,
    });
    res.json({ ok: true, entries, count: entries.length });
  });

  router.get("/api/activity/history", async (req, res) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit || "80"), 10) || 80, 500);
      const entries = await loadAuditHistory(limit);
      res.json({ ok: true, entries, source: "audit_file" });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/activity/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const send = (entry: ActivityEntry) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    };

    for (const entry of getRecentActivity(30).reverse()) send(entry);

    const unsub = subscribeActivity(send);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);

    req.on("close", () => {
      unsub();
      clearInterval(ping);
    });
  });

  return router;
}