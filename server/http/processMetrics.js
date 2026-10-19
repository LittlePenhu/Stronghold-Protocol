// server/http/processMetrics.js — the process figures of GET /healthz: memory and event-loop delay.
//
// A server-run field, a `SP_VERIFY` replay and a bot's rehearsal all step a battle in 8 ms slices on this process's only
// thread (server/match/fields.js HEADLESS_SLICE_MS), so "the game stutters" and "the event loop is behind" are the same
// question for a long-running deployment. These are the numbers a container monitor wants next to the lobby's own
// counters (sockets / sessions / rooms / matches):
//
//   pid, rssMb, heapUsedMb, heapTotalMb, externalMb   — process.memoryUsage() in MiB (rounded).
//   eventLoop: { p50Ms, p99Ms, maxMs }                — the delay histogram since start (perf_hooks.monitorEventLoopDelay,
//                                                       20 ms resolution), in ms, one decimal. Omitted until the first
//                                                       sample (`count` 0 in the first milliseconds of a process).
//
// The histogram is created on the first call and kept. It does not keep the process alive by itself (measured: a process
// that enables it and lets its last timer fire exits by itself), so a test that asked /healthz still ends.

import { monitorEventLoopDelay } from 'node:perf_hooks';

const MB = 1024 * 1024;
const round = (n) => Number(n.toFixed(1));

/** @type {import('node:perf_hooks').Histogram | null} */
let histogram = null;

/** The histogram of the event-loop delay, enabled on first use. */
export function eventLoopHistogram() {
  if (!histogram) {
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
  }
  return histogram;
}

/** `process.memoryUsage()` in MiB. @param {NodeJS.MemoryUsage} [mem] */
export function memoryMetrics(mem = process.memoryUsage()) {
  return {
    pid: process.pid,
    rssMb: Math.round(mem.rss / MB),
    heapUsedMb: Math.round(mem.heapUsed / MB),
    heapTotalMb: Math.round(mem.heapTotal / MB),
    externalMb: Math.round(mem.external / MB),
  };
}

/**
 * The `process` object of GET /healthz (never throws: a metrics failure must not take the health check down).
 * @returns {{ pid: number, rssMb: number, heapUsedMb: number, heapTotalMb: number, externalMb: number,
 *   eventLoop?: { p50Ms: number, p99Ms: number, maxMs: number } }}
 */
export function processMetrics() {
  const out = memoryMetrics();
  try {
    const h = eventLoopHistogram();
    if (h.count > 0) {
      out.eventLoop = { p50Ms: round(h.percentile(50) / 1e6), p99Ms: round(h.percentile(99) / 1e6), maxMs: round(h.max / 1e6) };
    }
  } catch { /* no histogram: the memory figures are still useful */ }
  return out;
}
