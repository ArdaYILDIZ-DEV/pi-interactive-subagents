/**
 * Shared running-children counter (extracted from `index.ts` / `subagent-done.ts`).
 *
 * Pure move: the cross-instance sharing mechanism is unchanged — the getter
 * is still published on `globalThis` under the same `Symbol.for` key, so any
 * consumer reading the slot (including older loaded copies) sees the same value.
 * The `globalThis` cast is now confined to this module.
 */
const RUNNING_CHILDREN_COUNT_KEY = Symbol.for(
 "pi-subagents/running-children-count",
);
// SAFETY: Symbol-keyed cross-instance counter slot; stored values are always () => number closures installed via publishRunningChildrenCount.
const globalRegistry = globalThis as unknown as Record<symbol, unknown>;

/** Publish the getter for the current session's live child count. */
export function publishRunningChildrenCount(getCount: () => number): void {
 globalRegistry[RUNNING_CHILDREN_COUNT_KEY] = getCount;
}

/** Returns the count of active child subagents spawned by this session. */
export function runningChildrenCount(): number {
 const fn = globalRegistry[RUNNING_CHILDREN_COUNT_KEY];
 if (typeof fn !== "function") return 0;
 try {
  const n = (fn as () => unknown)();
  return typeof n === "number" && n > 0 ? n : 0;
 } catch {
  return 0;
 }
}

/** Test-only reset so counter state never leaks between test cases. */
export function resetRunningChildrenCountForTests(): void {
 delete globalRegistry[RUNNING_CHILDREN_COUNT_KEY];
}
