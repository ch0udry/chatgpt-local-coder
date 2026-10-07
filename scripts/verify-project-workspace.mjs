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
  "scripts/test-project-registry.mjs",
  "scripts/test-project-registry-bootstrap.mjs",
  "scripts/test-session-project-state.mjs",
  "scripts/test-active-project-defaults.mjs",
  "scripts/test-project-instructions.mjs",
  "scripts/test-mcp-instructions.mjs",
  "scripts/test-skill-tools.mjs",
  "scripts/test-project-tools.mjs",
  "scripts/test-project-admin-api.mjs",
  "scripts/test-projects-ui.mjs",
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
