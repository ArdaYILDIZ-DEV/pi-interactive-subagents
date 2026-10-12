import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverAgentDefinitions,
  getFrontmatterValue,
  loadAgentDefaults,
  parseAgentDefinition,
} from "../../pi-extension/subagents/agents/discovery.ts";

it("does not read the next key as the value of an empty frontmatter field", () => {
  const frontmatter = "tools: \t\nmodel: provider/model\nskills:\nthinking: high\n";
  assert.equal(getFrontmatterValue(frontmatter, "tools"), undefined);
  assert.equal(getFrontmatterValue(frontmatter, "skills"), undefined);
  assert.equal(getFrontmatterValue(frontmatter, "model"), "provider/model");
  assert.equal(getFrontmatterValue(frontmatter, "thinking"), "high");
});

it("parses CRLF agent definitions without corrupting the body or blank fields", () => {
  const profile = parseAgentDefinition("---\r\nname: custom\r\ntools:\r\nmodel: provider/model\r\nauto-exit: false\r\nsubagent_agents: scout, researcher\r\n---\r\nFirst line\r\nSecond line\r\n", "fallback");
  assert.ok(profile);
  assert.equal(profile.name, "custom");
  assert.equal(profile.tools, undefined);
  assert.equal(profile.model, "provider/model");
  assert.equal(profile.autoExit, false);
  assert.deepEqual(profile.subagentAgents, ["scout", "researcher"]);
  assert.equal(profile.body, "First line\r\nSecond line");
});

it("preserves package/global/project precedence and hidden definitions", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iss-discovery-"));
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  });
  process.chdir(dir);
  process.env.PI_CODING_AGENT_DIR = join(dir, "global");
  const globalDir = join(dir, "global", "agents");
  const projectDir = join(dir, ".pi", "agents");
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const scout = () => discoverAgentDefinitions().find((a) => a.name === "scout")!;
  assert.equal(scout().source, "package");
  writeFileSync(join(globalDir, "scout.md"), "---\nname: scout\ntools: read\nmodel: global-model\n---\nGlobal scout");
  assert.equal(scout().source, "global");
  assert.equal(loadAgentDefaults("scout")!.model, "global-model");
  writeFileSync(join(projectDir, "scout.md"), "---\nname: scout\ntools: read, grep\nmodel: project-model\ndisable-model-invocation: true\n---\nProject scout");
  assert.equal(scout().source, "project");
  assert.equal(scout().disableModelInvocation, true);
  assert.equal(loadAgentDefaults("Scout")!.model, "project-model");
  assert.equal(loadAgentDefaults("missing-profile"), null);
});
