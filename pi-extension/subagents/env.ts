/**
 * Parses an integer from an environment variable string with bounds validation.
 */
export function parseEnvInt(
  raw: string | undefined,
  fallback: number,
  min: number,
): number {
  const trimmed = raw?.trim();
  const parsed = trimmed ? Number.parseInt(trimmed, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}
