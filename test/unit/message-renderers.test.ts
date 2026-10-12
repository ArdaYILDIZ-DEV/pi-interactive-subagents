import { it } from "node:test";
import assert from "node:assert/strict";
import { initTheme, type ExtensionAPI, type MessageRenderer, type Theme } from "@earendil-works/pi-coding-agent";
import { registerSubagentMessageRenderers } from "../../pi-extension/subagents/tui/message-renderers.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

it("renders dispatcher errors as failures without claiming a provider cause", () => {
  initTheme("dark", false);
  const renderers = new Map<string, MessageRenderer>();
  registerSubagentMessageRenderers({
    registerMessageRenderer(name: string, renderer: MessageRenderer) { renderers.set(name, renderer); },
  } as unknown as ExtensionAPI);
  const render = renderers.get("subagent_result")!;
  for (const details of [
    { name: "worker", error: "watch failed" },
    { name: "worker", exitCode: 1, errorMessage: "pane disappeared" },
  ]) {
    const component = render({
      role: "custom", customType: "subagent_result", display: true, timestamp: 0,
      content: "Failure happened", details,
    }, { expanded: true, outputPad: 0 }, theme);
    assert.ok(component);
    const output = component.render(80).join("\n");
    assert.match(output, /failed/);
    assert.doesNotMatch(output, /provider\/agent error/);
  }
});
