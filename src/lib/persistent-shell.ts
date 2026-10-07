import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { loadGlobalShellState, saveGlobalShellState } from "./global-shell-state.js";

export interface ShellExecResult {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
}

export interface PersistentShellSession {
  ensureContext(): Promise<void>;
  getCwd(): Promise<string>;
  getStatus(): Promise<{
    active: boolean;
    cwd: string;
    started_at: string | null;
    recent_commands: string[];
  }>;
  reset(cwd?: string): Promise<void>;
  exec(
    command: string,
    timeoutMs: number,
    workingDirectory?: string
  ): Promise<ShellExecResult>;
}

const MAX_HISTORY = 50;

function stripQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function resolveCdTarget(current: string, target: string): string {
  const cleaned = stripQuotes(target);
  if (cleaned === "-" || cleaned === "~") return current;
  return path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(current, cleaned);
}

/** Update cwd when cd / Set-Location appears at the beginning of a command. */
export function applyCwdDirectives(currentCwd: string, command: string): { cwd: string; command: string } {
  let cwd = currentCwd;
  let rest = command.trim();

  for (let i = 0; i < 8; i++) {
    const psMatch = rest.match(/^(?:Set-Location|sl)\s+(.+?)(?:\s*;\s*|\s*&&\s*|$)/i);
    if (psMatch) {
      cwd = resolveCdTarget(cwd, psMatch[1]);
      rest = rest.slice(psMatch[0].length).trim();
      continue;
    }

    const cdMatch = rest.match(/^cd(?:\s+(.+?))?(?:\s*;\s*|\s*&&\s*|$)/i);
    if (cdMatch) {
      if (cdMatch[1]) cwd = resolveCdTarget(cwd, cdMatch[1]);
      rest = rest.slice(cdMatch[0].length).trim();
      continue;
    }

    const pushdMatch = rest.match(/^pushd\s+(.+?)(?:\s*;\s*|\s*&&\s*|$)/i);
    if (pushdMatch) {
      cwd = resolveCdTarget(cwd, pushdMatch[1]);
      rest = rest.slice(pushdMatch[0].length).trim();
      continue;
    }

    break;
  }

  return { cwd, command: rest || "pwd" };
}

function runOnce(command: string, cwd: string, timeoutMs: number): Promise<ShellExecResult> {
  return new Promise((resolve, reject) => {
    const validCwd = fs.existsSync(cwd) ? cwd : process.cwd();
    const shell = process.platform === "win32" ? "powershell.exe" : (process.env.SHELL || "bash");
    const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command];
    const child = spawn(shell, args, { cwd: validCwd, windowsHide: true, env: process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Command timed out after ${timeoutMs / 1000}s`));
        return;
      }
      resolve({
        command,
        cwd,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exit_code: code,
        timed_out: false,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export function createPersistentShellSession(
  sessionId: string,
  getDefaultCwd: () => string,
  getContextKey: () => string
): PersistentShellSession {
  let cwd: string | null = null;
  let initializedAt: string | null = null;
  let contextKey: string | null = null;
  let persistenceKey: string | null = null;
  const history: string[] = [];

  function resetInMemory(nextCwd: string): void {
    cwd = path.resolve(nextCwd);
    initializedAt = new Date().toISOString();
    history.length = 0;
  }

  async function ensureContext(): Promise<void> {
    const nextContextKey = getContextKey();
    const defaultCwd = path.resolve(getDefaultCwd());

    if (contextKey === nextContextKey && cwd) return;

    const nextPersistenceKey = `${sessionId}:${nextContextKey}`;

    if (contextKey === null) {
      const saved = await loadGlobalShellState(nextPersistenceKey, defaultCwd);
      contextKey = nextContextKey;
      persistenceKey = nextPersistenceKey;
      if (saved?.cwd) {
        cwd = path.resolve(saved.cwd);
        initializedAt = saved.updated_at;
        history.length = 0;
        history.push(...(saved.recent_commands ?? []).slice(-MAX_HISTORY));
        return;
      }
      resetInMemory(defaultCwd);
      return;
    }

    contextKey = nextContextKey;
    persistenceKey = nextPersistenceKey;
    resetInMemory(defaultCwd);
  }

  async function save(command?: string): Promise<void> {
    if (!persistenceKey || !cwd) return;
    const previous = await loadGlobalShellState(persistenceKey, getDefaultCwd());
    await saveGlobalShellState(persistenceKey, cwd, command, previous);
  }

  return {
    async ensureContext() {
      await ensureContext();
    },

    async getCwd() {
      await ensureContext();
      return cwd!;
    },

    async getStatus() {
      await ensureContext();
      return {
        active: cwd !== null,
        cwd: cwd!,
        started_at: initializedAt,
        recent_commands: [...history].slice(-10),
      };
    },

    async reset(nextCwd?: string) {
      await ensureContext();
      resetInMemory(nextCwd ?? getDefaultCwd());
      await save();
    },

    async exec(command: string, timeoutMs: number, workingDirectory?: string) {
      await ensureContext();

      if (workingDirectory) {
        cwd = path.resolve(workingDirectory);
      }

      const applied = applyCwdDirectives(cwd!, command);
      cwd = applied.cwd;

      history.push(applied.command);
      if (history.length > MAX_HISTORY) history.shift();

      const result = await runOnce(applied.command, cwd, timeoutMs);
      cwd = result.cwd;
      await save(applied.command);
      return result;
    },
  };
}

// Legacy single-session wrappers retained for direct callers/tests.
// MCP server sessions use createPersistentShellSession instead.
const legacyShell = createPersistentShellSession(
  "legacy",
  () => legacyDefaultCwd,
  () => path.resolve(legacyDefaultCwd)
);
let legacyDefaultCwd = process.cwd();

export function setShellPersistenceRoot(workspaceRoot: string): void {
  legacyDefaultCwd = path.resolve(workspaceRoot);
}

export function initShellSession(defaultCwd: string): void {
  legacyDefaultCwd = path.resolve(defaultCwd);
}

export async function bootstrapShellSession(defaultCwd: string): Promise<void> {
  legacyDefaultCwd = path.resolve(defaultCwd);
  await legacyShell.ensureContext();
}

export async function getShellCwd(): Promise<string> {
  return legacyShell.getCwd();
}

export function resetShellSession(cwd: string): void {
  legacyDefaultCwd = path.resolve(cwd);
  void legacyShell.reset(cwd);
}

export async function getShellStatus() {
  return legacyShell.getStatus();
}

export async function execInShellSession(
  command: string,
  defaultCwd: string,
  timeoutMs: number,
  workingDirectory?: string
): Promise<ShellExecResult> {
  legacyDefaultCwd = path.resolve(defaultCwd);
  return legacyShell.exec(command, timeoutMs, workingDirectory);
}
