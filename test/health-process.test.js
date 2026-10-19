// GET /healthz's process figures (server/http/processMetrics.js): memory in MiB and the event-loop delay histogram
// (a server-run field, a `SP_VERIFY` replay and a bot's rehearsal all step battles in 8 ms slices on the only thread, so
// the event loop's delay is what a long-running deployment wants to watch next to the lobby's counters).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from '../server/index.js';
import { memoryMetrics, processMetrics } from '../server/http/processMetrics.js';

function get(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('memoryMetrics: MiB integers of this process, never throwing', () => {
  const m = memoryMetrics();
  assert.equal(m.pid, process.pid);
  for (const k of ['rssMb', 'heapUsedMb', 'heapTotalMb', 'externalMb']) {
    assert.ok(Number.isInteger(m[k]) && m[k] >= 0, `${k} = ${m[k]}`);
  }
  assert.ok(m.heapUsedMb <= m.heapTotalMb, 'used heap fits in the total');
  assert.ok(m.rssMb >= m.heapTotalMb, 'RSS holds the heap');
});

test('processMetrics: the event-loop histogram appears once it has a sample, in ms', async () => {
  processMetrics(); // enables the histogram
  await new Promise((r) => setTimeout(r, 80));
  const p = processMetrics();
  assert.ok(p.eventLoop, 'a sample after 80 ms');
  for (const k of ['p50Ms', 'p99Ms', 'maxMs']) {
    assert.equal(typeof p.eventLoop[k], 'number', k);
    assert.ok(Number.isFinite(p.eventLoop[k]) && p.eventLoop[k] >= 0, `${k} = ${p.eventLoop[k]}`);
  }
  assert.ok(p.eventLoop.maxMs >= p.eventLoop.p50Ms, 'max covers p50');
});

test('/healthz carries the process figures and stays as it was otherwise (no traffic unless asked)', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  try {
    const h = JSON.parse((await get(srv.port, '/healthz')).body);
    assert.equal(h.ok, true);
    assert.equal(h.process.pid, process.pid, 'the server runs in this test process');
    for (const k of ['rssMb', 'heapUsedMb', 'heapTotalMb', 'externalMb']) assert.ok(Number.isInteger(h.process[k]), k);
    assert.equal(typeof h.sockets, 'number');
    assert.equal(typeof h.rooms, 'number');
    assert.equal(h.traffic, undefined, 'plain /healthz is unchanged');
    // a second call a moment later has the event-loop sample
    await new Promise((r) => setTimeout(r, 80));
    const again = JSON.parse((await get(srv.port, '/healthz')).body);
    for (const k of ['p50Ms', 'p99Ms', 'maxMs']) assert.equal(typeof again.process.eventLoop[k], 'number', k);
  } finally { await srv.close(); }
});
