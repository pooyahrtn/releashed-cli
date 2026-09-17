// OpenCode file-plugin entry for bounded visual history (tested 1.18.30 only).
//
// This module MUST export nothing but its default plugin function. The 1.18.30
// loader (plugin/index.ts getLegacyPlugins) iterates every module export,
// throws 'Plugin export is not a function' on any non-function export, and
// calls EACH function export as a plugin. All logic lives in
// ./visual-history-filter.ts so this entry stays default-only.
//
// Load from an isolated vision-session config, never a global editor config:
// `{ "plugin": ["file:///absolute/repo/lib/opencode-visual-history.mjs"] }`.
import { withCallerTiming } from "./caller-timing.ts";
import { visualHistoryTransform } from "./visual-history-filter.ts";
import type { VisualHistoryHooks } from "./visual-history-filter.ts";

type ExtraTimingHooks = Partial<
  Record<
    "chat.params" | "tool.execute.before" | "tool.execute.after" | "event",
    (...args: any[]) => Promise<void>
  >
>;

export default async function visualHistoryPlugin(): Promise<
  VisualHistoryHooks & ExtraTimingHooks
> {
  // Opt-in caller timing wraps the unchanged transform; when its env opt-in is
  // absent this returns the original transform reference with no extra hooks.
  return withCallerTiming(visualHistoryTransform);
}
