/**
 * Destructive command pattern matching for `safe_bash`.
 *
 * Implemented without runtime dependencies for isolated unit testing.
 * Optimized with fast-path keyword filtering to allow safe commands to return in O(1)
 * without evaluating complex regular expressions.
 */

const DANGEROUS_RM_TARGETS =
  "['\"]?(?:\\/[^\\s'\"]*|~\\/?[^\\s'\"]*|\\$\\{?HOME\\}?\\/?[^\\s'\"]*|\\*|\\.|\\.\\.(?:\\/[^\\s'\"]*)?|\\.\\/\\*|\\.\\*|\\.\\/\\.\\*)['\"]?";

export const DANGEROUS_PATTERNS: RegExp[] = [
  // Both orderings of flag and path are covered because argument order is not guaranteed.
  new RegExp(
    `(?:^|[;&|\`()$\\s])\\\\?(?:(?:\\/(?:usr\\/)?bin\\/)?['"]?rm['"]?|['"](?:\\/(?:usr\\/)?bin\\/)?rm['"])\\s+.*?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|['"]-[a-zA-Z]*[rR][a-zA-Z]*['"]|['"]--recursive['"]).*?\\s+${DANGEROUS_RM_TARGETS}(?=\\s|$|[;&|\`()$])`,
  ),
  new RegExp(
    `(?:^|[;&|\`()$\\s])\\\\?(?:(?:\\/(?:usr\\/)?bin\\/)?['"]?rm['"]?|['"](?:\\/(?:usr\\/)?bin\\/)?rm['"])\\s+.*?${DANGEROUS_RM_TARGETS}.*?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|['"]-[a-zA-Z]*[rR][a-zA-Z]*['"]|['"]--recursive['"])(?=\\s|$|[;&|\`()$])`,
  ),
  /\bsudo\b/,
  /\bpkexec\b/,
  /\bdoas\b/,
  /(?:^|[\s;&|`()$\\/])['"]?su['"]?\s+/,
  /(?:^|[\s;&|`()$\\/])['"]?systemctl['"]?\s+(?:-\S+\s+)*(?:poweroff|reboot|halt)\b/,
  /(?:^|[\s;&|`()$\\/])['"]?init['"]?\s+[06]\b/,
  /(?:^|[\s;&|`()$\\/])['"]?telinit['"]?\s+[06]\b/,
  /\bwipefs\b/,
  /\bmkfs\b/,
  /(?:^|[\s;&|`()$\\/])['"]?dd['"]?\s+.*?(?:if=|of=\/dev\/)/,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
  />\s*\/dev\/[snv]d[a-z0-9]/,
  />\s*\/dev\/nvme/,
  /\btee\s+(-[a-zA-Z]+\s+)*\/dev\/[snv]d[a-z0-9]/,
  /\btee\s+(-[a-zA-Z]+\s+)*\/dev\/nvme/,
  /\bchmod\s+(-[a-zA-Z]+\s+)?777\s+\//,
  /\bchown\s+(-[a-zA-Z]+\s+)?root/,
  /\bcurl\s.*\|\s*['"]?(ba)?sh\b/,
  /\bwget\s.*\|\s*['"]?(ba)?sh\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bkill\s+-9\s+1\b/,
  /\bkillall\b/,
  /\bfind\s+.*-delete\b/,
  /\bfind\s+.*-exec\s+rm\b/,
];

/** Fast pre-filter: if a command contains none of these tokens, no dangerous pattern can match. */
const SUSPICIOUS_TRIGGER =
  /(?:rm|sudo|pkexec|doas|\bsu\b|systemctl|init|telinit|wipefs|mkfs|\bdd\b|chmod|chown|curl|wget|shutdown|reboot|kill|find|\/dev\/|:\(\)|>|tee)/i;

/** Returns a rejection reason if `command` matches any dangerous pattern, otherwise null. */
export function isDangerous(command: string): string | null {
  if (typeof command !== "string" || command.length === 0) return null;

  const normalized = command.replace(/\\\r?\n/g, " ").replace(/[\r\n]+/g, " ");

  // Fast early-out for benign commands (ls, cat, git, npm, pytest, etc.)
  if (!SUSPICIOUS_TRIGGER.test(normalized)) {
    return null;
  }

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(normalized)) {
      return `Command blocked by safe_bash: matches dangerous pattern ${pattern}`;
    }
  }
  return null;
}
