import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const union = (intervals: number[][]): number => {
  let end = 0, total = 0;
  for (const [start, stop] of intervals.sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, stop - Math.max(start, end));
    end = Math.max(end, stop);
  }
  return total;
};

type LocalSpan = {
  id: number;
  parent_id: number | null;
  name: string;
  start_ms: number;
  end_ms?: number;
  status: string;
};

type OperationRow = {
  calls: number;
  errors: number;
  unfinished: number;
  total_ms: number;
  exclusive_ms: number;
  max_ms: number;
};

export type LocalTimingOptions = {
  outputRoot: string;
  clock?: () => number;
  warn?: (message: string) => void;
};

// Fixed operation labels only. Never pass tool arguments, URLs, commands or error messages.
// These mutable diagnostics deliberately live outside the sealed screenshot candidate.
export function createLocalTiming({ outputRoot, clock = () => performance.now(), warn = (message: string) => process.stderr.write(`${message}\n`) }: LocalTimingOptions) {
  const attemptId = randomUUID();
  const directory = join(outputRoot, "diagnostics", attemptId);
  const startedAt = new Date().toISOString(), started = clock();
  const context = new AsyncLocalStorage<number>(), spans: LocalSpan[] = [];
  let runId: string | null = null, queue: Promise<void> = Promise.resolve(), failed = false, sequence = 0;
  const offset = () => Math.max(0, clock() - started);
  function enqueue(work: () => Promise<void>): Promise<void> {
    queue = queue.then(async () => { if (!failed) await work(); }).catch(() => {
      failed = true;
      warn(`Local timing could not be written at ${directory}; check permissions and disk space. Capture continues.`);
    });
    return queue;
  }
  enqueue(async () => { await mkdir(directory, { recursive: true, mode: 0o700 }); });
  function event(value: Record<string, unknown>): void {
    const line = JSON.stringify({ schema_version: 1, attempt_id: attemptId, run_id: runId, ...value }) + "\n";
    enqueue(() => appendFile(join(directory, "timings.jsonl"), line, { mode: 0o600 }));
  }
  event({ type: "start", started_at: startedAt, at_ms: 0 });

  async function span<T>(name: string, work: () => Promise<T>): Promise<T> {
    const item: LocalSpan = { id: ++sequence, parent_id: context.getStore() ?? null, name, start_ms: offset(), status: "running" };
    spans.push(item);
    event({ type: "span_start", ...item });
    try {
      const value = await context.run(item.id, work);
      item.status = (value as { isError?: unknown } | null | undefined)?.isError ? "error" : "ok";
      return value;
    } catch (error) {
      item.status = "error";
      throw error;
    } finally {
      item.end_ms = offset();
      event({ type: "span_end", ...item, duration_ms: item.end_ms - item.start_ms });
    }
  }

  function summary() {
    const wall = offset();
    const roots = spans.filter((item) => item.parent_id === null);
    const busy = union(roots.map((item) => [item.start_ms, item.end_ms ?? wall]));
    const operations: Record<string, OperationRow> = {};
    for (const item of spans) {
      const duration = (item.end_ms ?? wall) - item.start_ms;
      const children = spans.filter((child) => child.parent_id === item.id);
      const exclusive = Math.max(0, duration - union(children.map((child) => [child.start_ms, child.end_ms ?? wall])));
      const row = operations[item.name] ??= { calls: 0, errors: 0, unfinished: 0, total_ms: 0, exclusive_ms: 0, max_ms: 0 };
      row.calls++;
      row.errors += Number(item.status === "error");
      row.unfinished += Number(item.status === "running");
      row.total_ms += duration;
      row.exclusive_ms += exclusive;
      row.max_ms = Math.max(row.max_ms, duration);
    }
    let cursor = 0;
    const gaps: Array<{ start_ms: number; duration_ms: number }> = [];
    for (const item of roots.sort((a, b) => a.start_ms - b.start_ms)) {
      if (item.start_ms > cursor) gaps.push({ start_ms: cursor, duration_ms: item.start_ms - cursor });
      cursor = Math.max(cursor, item.end_ms ?? wall);
    }
    if (wall > cursor) gaps.push({ start_ms: cursor, duration_ms: wall - cursor });
    return { schema_version: 1, attempt_id: attemptId, run_id: runId, started_at: startedAt,
      wall_ms: wall, measured_operation_ms: busy, unobserved_ms: Math.max(0, wall - busy),
      operations, longest_unobserved_gaps: gaps.sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 10),
      scope: "Wall time, not CPU time. Nested total_ms overlaps; exclusive_ms excludes child operations. Unobserved time includes caller/transport gaps, pauses and diagnostic writes, not measured model latency. Concurrent operations may overlap even in exclusive totals.",
      unavailable: ["preparation outside this process", "caller model latency and cost", "product inference cost", "image delivery after the tool response"],
    };
  }

  async function flush(): Promise<{ summary: ReturnType<typeof summary>; markdown: string } | null> {
    // Enqueue the snapshot after preceding event writes, including their elapsed overhead.
    let receipt: { summary: ReturnType<typeof summary>; markdown: string } | undefined;
    await enqueue(async () => {
      const report = summary();
      const seconds = (ms: number): string => (ms / 1000).toFixed(3);
      const rows = Object.entries(report.operations).map(([name, value]) => `| ${name} | ${value.calls} | ${value.errors} | ${value.unfinished} | ${seconds(value.total_ms)} | ${seconds(value.exclusive_ms)} | ${seconds(value.max_ms)} |`);
      const markdown = `# Local capture timing\n\nAttempt: ${attemptId}; run: ${runId ?? "not started"}\n\nElapsed: ${seconds(report.wall_ms)} s; measured operations: ${seconds(report.measured_operation_ms)} s; unobserved: ${seconds(report.unobserved_ms)} s.\n\n${report.scope}\n\n| Operation | Calls | Errors | Unfinished | Total s | Exclusive s | Max s |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows.join("\n")}\n\nNot measured: ${report.unavailable.join("; ")}.\n`;
      receipt = { summary: report, markdown };
      for (const [name, bytes] of [["summary.json", JSON.stringify(report, null, 2) + "\n"], ["summary.md", markdown]]) {
        await writeFile(join(directory, `${name}.tmp`), bytes, { mode: 0o600 });
        await rename(join(directory, `${name}.tmp`), join(directory, name));
      }
    });
    return receipt ?? null;
  }
  return { span, summary, flush, directory, attemptId,
    bindRun(id: string): void { runId = id; event({ type: "run", at_ms: offset() }); },
  };
}

export type LocalTiming = ReturnType<typeof createLocalTiming>;
