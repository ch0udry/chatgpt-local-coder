export type ToolProfileName = "full" | "slim";

/** Core tools for ChatGPT web — smaller tools/list payload, fewer discovery errors. */
export const SLIM_CHATGPT_TOOLS = new Set([
  "agent_status",
  "project_context",
  "list_projects",
  "use_project",
  "list_skills",
  "load_skill",
  "glob",
  "grep",
  "read_text_file",
  "load_path_rules",
  "apply_patch",
  "write_file",
  "rewind",
  "create_directory",
  "delete_file",
  "copy_file",
  "move_file",
  "run_command",
  "start_process",
  "process_output",
  "git_status",
  "git_diff",
  "git_add",
  "git_commit",
  "git_restore",
  "mcp_servers",
  "mcp_tools",
  "mcp_call",
]);

export function getChatGptToolProfile(): ToolProfileName {
  const raw = (process.env.CHATGPT_TOOL_PROFILE || "slim").trim().toLowerCase();
  return raw === "full" ? "full" : "slim";
}

export function shouldExposeTool(name: string, profile: ToolProfileName = getChatGptToolProfile()): boolean {
  if (profile === "full") return true;
  if (name.includes("__")) return true;
  return SLIM_CHATGPT_TOOLS.has(name);
}
