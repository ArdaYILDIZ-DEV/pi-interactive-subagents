/**
 * Agent discovery (extracted from `index.ts` — pure move, no behavior change).
 *
 * Project > global > bundled precedence with later sources overwriting
 * earlier ones by agent name. `SUBAGENT_ALLOWLIST` filtering preserved.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

const DISCOVERY_DIR = dirname(fileURLToPath(import.meta.url));

export function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function getBundledAgentsDir(): string {
  return join(DISCOVERY_DIR, "../../../agents");
}

export interface AgentDefaults {
  name: string;
  description?: string;
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  subagentAgents?: string[];
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  cwd?: string;
  body?: string;
  disableModelInvocation: boolean;
}

export interface ListedAgentDefinition extends AgentDefaults {
  source: "package" | "global" | "project";
}

/**
 * Pinned set of allowed spawn targets from PI_SUBAGENT_ALLOWED.
 * `null` indicates an unrestricted top-level session.
 */
export const SUBAGENT_ALLOWLIST: Set<string> | null = (() => {
  const raw = process.env.PI_SUBAGENT_ALLOWED;
  if (!raw) return null;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? new Set(list) : null;
})();

export function getFrontmatterValue(
  frontmatter: string,
  key: string,
): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

export function parseCommaList(
  value: string | undefined,
): string[] | undefined {
  if (value == null) return undefined;
  const list = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

export function parseOptionalBoolean(
  value: string | undefined,
): boolean | undefined {
  return value == null ? undefined : value === "true";
}

export function parseSystemPromptMode(
  value: string | undefined,
): "append" | "replace" | undefined {
  if (value === "replace") return "replace";
  if (value === "append") return "append";
  return undefined;
}

export function parseAgentDefinition(
  content: string,
  fallbackName: string,
): AgentDefaults | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    skills:
      getFrontmatterValue(frontmatter, "skill") ??
      getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    subagentAgents: parseCommaList(
      getFrontmatterValue(frontmatter, "subagent_agents"),
    ),
    autoExit: parseOptionalBoolean(
      getFrontmatterValue(frontmatter, "auto-exit"),
    ),
    interactive: parseOptionalBoolean(
      getFrontmatterValue(frontmatter, "interactive"),
    ),
    systemPromptMode: parseSystemPromptMode(
      getFrontmatterValue(frontmatter, "system-prompt"),
    ),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(
        frontmatter,
        "disable-model-invocation",
      )?.toLowerCase() === "true",
  };
}

export function loadAgentDefaults(agentName: string): AgentDefaults | null {
  const configDir = getAgentConfigDir();
  const normalized = agentName.toLowerCase();
  const candidatePaths = [
    join(process.cwd(), ".pi", "agents", `${agentName}.md`),
    join(process.cwd(), ".pi", "agents", `${normalized}.md`),
    join(configDir, "agents", `${agentName}.md`),
    join(configDir, "agents", `${normalized}.md`),
    join(getBundledAgentsDir(), `${agentName}.md`),
    join(getBundledAgentsDir(), `${normalized}.md`),
  ];
  for (const candidatePath of candidatePaths) {
    if (!existsSync(candidatePath)) continue;
    const parsed = parseAgentDefinition(
      readFileSync(candidatePath, "utf8"),
      agentName,
    );
    if (parsed) return parsed;
  }
  return null;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir).filter((e) => e.endsWith(".md"));
  } catch {
    return [];
  }
}

export function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: ListedAgentDefinition["source"] }> =
    [
      { path: getBundledAgentsDir(), source: "package" },
      { path: join(getAgentConfigDir(), "agents"), source: "global" },
      { path: join(process.cwd(), ".pi", "agents"), source: "project" },
    ];
  for (const { path: dir, source } of dirs) {
    for (const file of readdirSafe(dir)) {
      const parsed = parseAgentDefinition(
        readFileSync(join(dir, file), "utf8"),
        file.replace(/\.md$/, ""),
      );
      if (!parsed) continue;
      agents.set(parsed.name, { ...parsed, source });
    }
  }
  const all = [...agents.values()];
  return SUBAGENT_ALLOWLIST
    ? all.filter((a) => SUBAGENT_ALLOWLIST.has(a.name))
    : all;
}
