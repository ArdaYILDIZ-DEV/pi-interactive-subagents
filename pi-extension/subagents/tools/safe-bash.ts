/**
 * Safe bash tool wrapper that blocks destructive commands.
 *
 * Loaded into child subagents when configured with `safe_bash`.
 * Intercepts dangerous operations before delegating execution to the built-in bash tool.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { isDangerous } from "./dangerous.ts";

export default function (pi: ExtensionAPI) {
  const bashTool = createBashTool(process.cwd());

  pi.registerTool({
    name: "safe_bash",
    label: "Safe Bash",
    description: "Execute a bash command. Blocks dangerous commands (rm -rf /, sudo, mkfs, etc.).",
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to execute" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate) {
      const danger = isDangerous(params.command);
      if (danger) {
        throw new Error(danger);
      }
      return bashTool.execute(toolCallId, params, signal, onUpdate);
    },
  });
}
