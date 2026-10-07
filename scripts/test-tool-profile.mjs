/**
 * Verify slim tool profile exposes expected tools only.
 */
import { SLIM_CHATGPT_TOOLS, shouldExposeTool } from "../dist/lib/tool-profile.js";
import { createMcpServer } from "../dist/server-factory.js";

const EXPECTED_LOCAL_SLIM = [
  "agent_status", "runtime_context", "project_context", "list_projects", "list_skills", "load_skill",
  "glob", "grep",
  "read_text_file", "load_path_rules", "apply_patch", "write_file", "rewind",
  "create_directory", "delete_file", "copy_file", "move_file",
  "run_command", "start_process", "process_output",
  "git_status", "git_diff", "git_add", "git_commit", "git_restore",
  "mcp_servers", "mcp_tools", "mcp_call",
];

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e}`); failed++; }

try {
  const configured = [...SLIM_CHATGPT_TOOLS].sort();
  const expectedLocal = [...EXPECTED_LOCAL_SLIM].sort();
  if (JSON.stringify(configured) !== JSON.stringify(expectedLocal)) {
    throw new Error(`unexpected slim allowlist:\n${configured.join("\n")}`);
  }
  ok(`slim profile has exactly ${SLIM_CHATGPT_TOOLS.size} tools`);

  for (const name of ["edit_file", "multi_edit", "list_directory", "shell_status", "shell_reset", "stop_process"]) {
    if (shouldExposeTool(name, "slim")) throw new Error(`${name} should be hidden in slim`);
  }
  ok("duplicate and shell maintenance tools hidden in slim");

  if (!shouldExposeTool("example-mcp__allowed_tool", "slim")) {
    throw new Error("proxied tools should be admitted dynamically in slim");
  }
  ok("slim admits dynamically registered proxied tools");

  if (!shouldExposeTool("mcp_call", "full")) throw new Error("full should expose all");
  ok("full profile exposes all");

  const configs = [
    { id: "codebase-retrieval", tool_prefix: "codebase_retrieval", tools: ["codebase-retrieval", "file-retrieval"] },
    { id: "codebase-memory-mcp", tools: ["get_architecture", "trace_path"] },
    { id: "gitnexus", tools: ["detect_changes", "impact"] },
    { id: "tokensave", tools: [
      "tokensave_affected", "tokensave_record_decision",
      "tokensave_record_code_area", "tokensave_session_recall",
    ] },
  ];
  const manager = {
    listServerConfigs: () => configs.map((config) => ({
      ...config, name: config.id, enabled: true, expose: "allowlist",
    })),
    listTools: async (id) => configs.find((config) => config.id === id).tools
      .map((name) => ({ name, inputSchema: { type: "object" } })),
    registerMcpServer: () => {},
    callTool: async () => ({}),
  };
  process.env.CHATGPT_TOOL_PROFILE = "slim";
  const server = await createMcpServer(process.cwd(), 1, [process.cwd()], true, manager);
  const registered = Object.keys(server._registeredTools).sort();
  const expected = [
    ...EXPECTED_LOCAL_SLIM,
    "codebase_retrieval__codebase-retrieval", "codebase_retrieval__file-retrieval",
    "codebase-memory-mcp__get_architecture", "codebase-memory-mcp__trace_path",
    "gitnexus__detect_changes", "gitnexus__impact",
    "tokensave__tokensave_affected", "tokensave__tokensave_record_decision",
    "tokensave__tokensave_record_code_area", "tokensave__tokensave_session_recall",
  ].sort();
  if (JSON.stringify(registered) !== JSON.stringify(expected)) {
    throw new Error(`schema/runtime mismatch:\n${registered.join("\n")}`);
  }
  ok("initial tools/list exactly matches local slim tools plus proxied tools");
} catch (e) {
  fail("tool profile", e.message || e);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
