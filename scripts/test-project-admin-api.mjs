import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "pws008-"));
const registryPath = path.join(root, "profiles", "projects.toml");
const projectA = path.join(root, "project-a");
const projectB = path.join(root, "project-b");
const globalSkills = path.join(root, "global-skills");
await mkdir(path.join(projectA, ".claude", "skills", "project-skill"), { recursive: true });
await mkdir(projectB, { recursive: true });
await mkdir(path.join(globalSkills, "global-skill"), { recursive: true });
await writeFile(path.join(projectA, "AGENTS.md"), "# A\nA_CONTEXT\n", "utf8");
await writeFile(
  path.join(projectA, ".claude", "skills", "project-skill", "SKILL.md"),
  "---\nname: project-skill\ndescription: project skill\n---\nPROJECT_SKILL",
  "utf8"
);
await writeFile(
  path.join(globalSkills, "global-skill", "SKILL.md"),
  "---\nname: global-skill\ndescription: global skill\n---\nGLOBAL_SKILL",
  "utf8"
);
process.env.CHATGPT_GLOBAL_SKILLS_DIR = globalSkills;

const { createAdminRouter } = await import("../dist/admin/routes.js");

const manager = {
  listStatuses: async () => [],
  getConfig: () => ({ version: 1, servers: [] }),
  getConfigPath: () => path.join(root, "mcp-upstream.json"),
};

const app = express();
app.use(express.json());
app.use(createAdminRouter(manager, {
  mcpPort: 3333,
  pid: process.pid,
  sessionCount: () => 0,
  projectRegistryPath: registryPath,
}));

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("listen failed");
const base = `http://127.0.0.1:${address.port}`;

async function request(method, url, body) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

try {
  let result = await request("GET", "/api/projects");
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.deepEqual(result.json.projects, []);
  console.log("OK  empty registry lists cleanly");

  result = await request("POST", "/api/projects", { name: "Project A", path: projectA });
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  const idA = result.json.project.id;
  assert.ok(idA);
  assert.equal(result.json.project.path, projectA);
  console.log("OK  project add persists normalized config");

  result = await request("POST", "/api/projects", { name: "Duplicate Path", path: projectA });
  assert.equal(result.status, 400);
  assert.match(result.json.error, /duplicate project path/i);

  result = await request("POST", "/api/projects", { name: "Missing", path: path.join(root, "missing") });
  assert.equal(result.status, 400);
  assert.match(result.json.error, /directory|not found|exist/i);
  console.log("OK  duplicate and invalid paths return clear errors");

  result = await request("POST", "/api/projects", { name: "Project B", path: projectB });
  assert.equal(result.status, 200);
  const idB = result.json.project.id;

  result = await request("PUT", `/api/projects/${idA}`, {
    name: "Project A Edited",
    use_default_instruction: false,
    instruction: "A_CUSTOM",
    pinned_skills: ["global-skill"],
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.project.name, "Project A Edited");
  assert.equal(result.json.project.use_default_instruction, false);
  assert.equal(result.json.project.instruction, "A_CUSTOM");
  console.log("OK  project edit round-trip persists");

  result = await request("PUT", `/api/projects/${idB}/primary`);
  assert.equal(result.status, 200);
  assert.equal(result.json.config.primary_project, idB);

  result = await request("GET", "/api/projects/config");
  assert.equal(result.json.config.primary_project, idB);

  result = await request("PUT", "/api/projects/config", {
    default_project_instruction: "DEFAULT_PROJECT_RULE",
    primary_project: idA,
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.config.primary_project, idA);
  assert.equal(result.json.config.default_project_instruction, "DEFAULT_PROJECT_RULE");
  console.log("OK  primary/default project config persists");

  result = await request("GET", `/api/projects/${idA}`);
  assert.equal(result.status, 200);
  assert.equal(result.json.project.primary, true);
  assert.equal(result.json.project.context.has_agents, true);

  result = await request("GET", `/api/projects/${idA}/inspect`);
  assert.equal(result.status, 200);
  assert.equal(result.json.project.id, idA);
  assert.ok(result.json.memory.sections.some((section) => section.path.endsWith("AGENTS.md")));
  console.log("OK  project get/inspect distinguish configured and detected context");

  result = await request("GET", `/api/projects/${idA}/skills`);
  assert.equal(result.status, 200);
  assert.ok(result.json.project_skills.some((skill) => skill.name === "project-skill"));
  assert.ok(result.json.global_skills.some((skill) => skill.name === "global-skill"));
  console.log("OK  project/global skill metadata API works");

  result = await request("DELETE", `/api/projects/${idA}`);
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal((await stat(projectA)).isDirectory(), true);
  assert.match(await readFile(path.join(projectA, "AGENTS.md"), "utf8"), /A_CONTEXT/);
  console.log("OK  remove unregisters only and leaves project directory intact");

  result = await request("GET", "/api/projects");
  assert.equal(result.status, 200);
  assert.equal(result.json.projects.length, 1);
  assert.equal(result.json.projects[0].id, idB);

  result = await request("GET", `/api/projects/${idA}`);
  assert.equal(result.status, 404);
  console.log("OK  CRUD round trip completes with clear not-found");

  console.log("\n9 passed, 0 failed");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
