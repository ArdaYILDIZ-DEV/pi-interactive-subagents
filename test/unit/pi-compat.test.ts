import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import registerSubagents from "../../pi-extension/subagents/index.ts";
import registerDone from "../../pi-extension/subagents/subagent-done.ts";
import registerSafeBash from "../../pi-extension/subagents/tools/safe-bash.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

it("declares the Pi 1.x support boundary and uses the public TypeBox package", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "^1.0.1");
  assert.equal(manifest.peerDependencies["@earendil-works/pi-tui"], "^1.0.1");
  assert.equal(manifest.peerDependencies.typebox, "^1.3.27");
  assert.equal(manifest.devDependencies["@earendil-works/pi-coding-agent"], "1.0.1");
  assert.equal(manifest.devDependencies["@earendil-works/pi-tui"], "1.0.1");
  assert.equal(manifest.devDependencies.typebox, "1.3.27");
  assert.equal(manifest.peerDependencies["@sinclair/typebox"], undefined);
  assert.equal(manifest.devDependencies["@sinclair/typebox"], undefined);
});

it("does not depend on legacy schema aliases or deep Pi module imports", () => {
  function inspect(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) inspect(path);
      else if (entry.name.endsWith(".ts")) {
        const source = readFileSync(path, "utf8");
        assert.doesNotMatch(source, /["']@sinclair\/typebox(?:\/[^"']*)?["']/,
          `legacy TypeBox alias in ${path}`);
        assert.doesNotMatch(source, /["']@earendil-works\/pi-(?:coding-agent|tui)\/[^"']+["']/,
          `deep Pi import in ${path}`);
      }
    }
  }
  inspect(join(root, "pi-extension/subagents"));
});

it("registers all tools with schemas validated by public TypeBox 1.x", () => {
  const schemas = new Map<string, TSchema>();
  const pi = {
    on() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    registerTool(tool: { name: string; parameters: TSchema }) { schemas.set(tool.name, tool.parameters); },
  } as unknown as ExtensionAPI;
  registerSubagents(pi);
  registerDone(pi);
  registerSafeBash(pi);
  const cases: Array<[string, unknown, unknown]> = [
    ["subagent", { agent: "scout", task: "inspect" }, { agent: "scout" }],
    ["subagents_list", {}, "not an object"],
    ["subagent_message", { name: "scout", message: "continue" }, { name: "scout" }],
    ["ask_question", { question: "Which option?" }, { question: 7 }],
    ["safe_bash", { command: "echo test", timeout: 1 }, { command: 7 }],
  ];
  for (const [name, valid, invalid] of cases) {
    assert.ok(schemas.has(name), `tool not registered: ${name}`);
    const validator = Compile(schemas.get(name)!);
    assert.equal(validator.Check(valid), true, `valid arguments rejected: ${name}`);
    assert.equal(validator.Check(invalid), false, `invalid arguments accepted: ${name}`);
  }
});

it("locks the tested host and schema versions consistently with the manifest", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  assert.deepEqual(lock.packages[""].peerDependencies, manifest.peerDependencies);
  for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
    assert.equal(lock.packages[`node_modules/${name}`].version, manifest.devDependencies[name]);
  }
  assert.equal(lock.packages["node_modules/@sinclair/typebox"], undefined);
});
