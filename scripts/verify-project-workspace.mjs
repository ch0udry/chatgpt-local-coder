import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

console.log("=== Existing focused regressions ===");
await run("npm", ["test"]); // npm test

const focused = [
  "scripts/test-project-registry-v2.mjs",
  "scripts/test-global-project-runtime.mjs",
  "scripts/test-runtime-context.mjs",
  "scripts/test-session-shell-isolation.mjs",
  "scripts/test-project-instructions.mjs",
  "scripts/test-mcp-instructions.mjs",
  "scripts/test-skill-tools.mjs",
  "scripts/test-project-tool-surface-v2.mjs",
  "scripts/test-admin-active-project.mjs",
  "scripts/test-admin-shell-mode.mjs",
  "scripts/test-admin-project-lifecycle.mjs",
  "scripts/test-active-project-ui.mjs",
  "scripts/test-project-runtime-e2e-v2.mjs",
  "scripts/test-production-v2-migration.mjs",
  "scripts/test-project-editor-ui.mjs",
  "scripts/test-settings-ui.mjs",
  "scripts/test-admin-ui-language.mjs",
  "scripts/test-project-workspace-completion.mjs",
];

console.log("\n=== Project Workspace System regressions ===");
for (const script of focused) {
  console.log(`\n--- ${script} ---`);
  await run(process.execPath, [path.join(root, script)]);
}

console.log("\n=== PROJECT WORKSPACE VERIFICATION PASSED ===");
