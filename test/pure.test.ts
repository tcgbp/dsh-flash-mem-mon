import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isFullGc, rssSlopePerMin, type PureSample } from '../src/pure.ts'

// ── isFullGc ─────────────────────────────────────────────────────────────

test('isFullGc: excludes minor (Scavenge) kind 1', () => {
  assert.equal(isFullGc(1), false)
})

test('isFullGc: excludes kind 0 (no GC)', () => {
  assert.equal(isFullGc(0), false)
})

test('isFullGc: classifies every non-scavenge phase as full', () => {
  // MarkSweepCompact (2), IncrementalMarking (4), ProcessWeakCallbacks (8)
  // and their combos 6, 10, 12, 14 — all are full (non-scavenge) cycles.
  for (const kind of [2, 4, 6, 8, 10, 12, 14]) {
    assert.equal(isFullGc(kind), true, `kind ${kind} should be full GC`)
  }
})

test('isFullGc: negative/NaN kinds are not full', () => {
  assert.equal(isFullGc(-2), false)
  assert.equal(isFullGc(NaN), false)
})

test('isFullGc: large even non-scavenge bitmasks are full; odd are scavenge', () => {
  // 2^30 is even → bit 0 clear → non-scavenge → full.
  assert.equal(isFullGc(Math.pow(2, 30)), true)
  // 2^30 + 1 sets bit 0 → scavenge → not full.
  assert.equal(isFullGc(Math.pow(2, 30) + 1), false)
})

// ── rssSlopePerMin ───────────────────────────────────────────────────────

const MIB = 1048576

function sample(ts: number, rssMB: number): PureSample {
  return { ts, rss: rssMB * MIB, heapUsed: 0, heapTotal: 0 }
}

/** Build a time-ordered series with equal spacing. */
function series(firstTS: number, stepMs: number, rssPerStepMB: number, count: number): PureSample[] {
  const out: PureSample[] = []
  let rss = 0
  for (let i = 0; i < count; i++) {
    out.push(sample(firstTS + i * stepMs, rss))
    rss += rssPerStepMB
  }
  return out
}

test('rssSlopePerMin: returns 0 with fewer than 3 samples', () => {
  assert.equal(rssSlopePerMin([sample(0, 100), sample(1000, 102)]), 0)
})

test('rssSlopePerMin: returns 0 for an empty series', () => {
  assert.equal(rssSlopePerMin([]), 0)
})

test('rssSlopePerMin: constant RSS → 0 slope', () => {
  const s = series(0, 5000, 0, 20)
  assert.equal(rssSlopePerMin(s), 0)
})

test('rssSlopePerMin: linear growth is reported as a positive MB/min slope', () => {
  // +2 MB every 5s → +2 * (60/5) = +24 MB/min. Tail covers the whole series.
  const s = series(0, 5000, 2, 20)
  const slope = rssSlopePerMin(s)
  assert.ok(slope > 0, `expected positive slope, got ${slope}`)
  assert.ok(Math.abs(slope - 24) < 1, `expected ~24 MB/min, got ${slope}`)
})

test('rssSlopePerMin: uses ONLY the tail span, not the whole buffer (regression)', () => {
  // 100 samples at 5s spacing = ~500s span. A buggy implementation that divided
  // by the FULL span (not the tail) would under-report the per-minute slope.
  // Build a 100-point series where the last 20 rise sharply while the rest are
  // flat, and confirm the slope reflects the sharp rise (tail governs).
  const out: PureSample[] = []
  for (let i = 0; i < 80; i++) out.push(sample(i * 5000, 100))
  for (let i = 80; i < 100; i++) out.push(sample(i * 5000, 100 + (i - 79) * 2))
  const slope = rssSlopePerMin(out)
  // Last 20 rise +2 MB per 5s → ~24 MB/min over the tail.
  assert.ok(slope > 10, `tail span must drive slope; got ${slope}`)
})

test('rssSlopePerMin: uniform spacing interval matches time steps', () => {
  // +1 MB every 1000ms → 60 MB/min.
  const s = series(0, 1000, 1, 20)
  const slope = rssSlopePerMin(s)
  assert.ok(Math.abs(slope - 60) < 1, `expected ~60 MB/min, got ${slope}`)
})