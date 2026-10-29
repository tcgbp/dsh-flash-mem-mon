// Pure, dependency-free helpers extracted from index.ts so they can be unit
// tested without pulling in cordis / node HTTP / GC-entry types. Everything
// here is a pure function of its inputs.

/** A memory sample as consumed by the slope/trend helpers. */
export interface PureSample {
  ts: number
  rss: number
  heapUsed: number
  heapTotal: number
}

/**
 * CANONICAL default alert configuration. This is the SINGLE source of truth
 * for every memory/GC threshold default.
 *
 * The host (`src/index.ts`) derives its `DEFAULT_*` Config values from this
 * object, and the browser client half (`lib/client.js`) keeps its own
 * `_MEM_ALERT_DEFAULTS` mirror for synchronous bootstrap (the client is a
 * deliberately no-build, single-file module that cannot `import` this ESM
 * host module). `test/defaults-drift.test.ts` asserts the two NEVER drift, so
 * editing one side without the other is a hard CI failure instead of a silent
 * divergence.
 */
export interface AlertDefaults {
  memThresholdInfo: number
  memThresholdWarning: number
  memThresholdError: number
  memThresholdCritical: number
  memPollBase: number
  memPollMin: number
  gcThresholdInfo: number
  gcThresholdWarning: number
  gcThresholdError: number
  memGrowthAlertPerMin: number
}

export const DEFAULT_ALERT_CONFIG: AlertDefaults = {
  memThresholdInfo: 256,
  memThresholdWarning: 512,
  memThresholdError: 1024,
  memThresholdCritical: 1536,
  memPollBase: 60000,
  memPollMin: 2000,
  gcThresholdInfo: 2,
  gcThresholdWarning: 5,
  gcThresholdError: 10,
  memGrowthAlertPerMin: 1,
}

/**
 * Classify a V8 GC `kind` bitmask as a full (major) cycle.
 *
 * V8 GC entry `kind` is a bitmask:
 *   1 << 0 = Scavenge (minor / young-gen)
 *   1 << 1 = MarkSweepCompact (major / full)
 *   1 << 2 = IncrementalMarking
 *   1 << 3 = ProcessWeakCallbacks
 *
 * In practice modern V8/Node reports a full MarkSweepCompact cycle through the
 * IncrementalMarking (4) and ProcessWeakCallbacks (8) phases — the standalone
 * "major" bit (2) is almost never emitted on its own.  Classifying Full GC by
 * `kind === 2` alone therefore misses (nearly) every real full collection.
 * The robust test: a Full GC is any NON-scavenge cycle, i.e. the Scavenge bit
 * (1) is NOT set.  This captures 2, 4, 6, 8, 10, 12, 14 while excluding minor
 * (1) scavenges.
 */
export function isFullGc(kind: number): boolean {
  return (kind & 1) === 0 && kind > 0
}

/**
 * Linear-regression slope of `rss` over the last `tailCount` samples, expressed
 * in MB/min. Returns 0 when there are not enough samples (fewer than 3) or the
 * tail time span is not positive.
 *
 * The average sample interval MUST be derived from the tail's OWN first/last
 * timestamps, NOT from the whole buffer span (see index.ts summary()). Using a
 * larger span inflates the interval, deflates samplesPerMin, and under-reports
 * MB/min — a monotonic-leak false negative.
 */
export function rssSlopePerMin(
  samples: PureSample[],
  tailCount = 20,
): number {
  const tail = samples.slice(-tailCount)
  if (tail.length < 3) return 0
  const n = tail.length
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0
  for (let i = 0; i < n; i++) {
    sumX += i
    sumY += tail[i].rss
    sumXY += i * tail[i].rss
    sumXX += i * i
  }
  // slope = bytes per sample-index step.
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX)
  const tailSpanMs = Math.max(tail[tail.length - 1].ts - tail[0].ts, 0)
  if (tailSpanMs <= 0) return 0
  const avgIntervalMs = tailSpanMs / (n - 1)
  const samplesPerMinute = 60000 / avgIntervalMs
  return Math.round((slope * samplesPerMinute / 1048576) * 100) / 100
}

// ── Session-footprint helpers ─────────────────────────────────────────────
// These are derived purely from collected inputs so the aggregate math and the
// human-readable formatting can be unit tested without touching the filesystem.

/**
 * Derive the number of ARCHIVED sessions that are still physically present on
 * disk. The DSH runtime's `workspaceRegistry.archivedSessionIds` lists archived
 * session ids, but some may have already been pruned from disk (so the disk
 * `sessions/<workspace>/session-<uuid>` directories can be fewer than the ids).
 * The truth source for "archived" is the runtime id list; the disk constrains
 * it to what still exists. Pass `sessionNames` as the on-disk directory names
 * (e.g. `new Set(['session-a', 'session-b', ...])`).
 */
export function countArchivedSessions(
  archivedIds: readonly string[],
  sessionNames: ReadonlySet<string>,
): number {
  let count = 0
  for (const id of archivedIds) {
    if (sessionNames.has(id) || sessionNames.has(`session-${id}`)) count++
  }
  return count
}

/** Format a byte count for display, e.g. 1536 → '1.5 KB', 7340032 → '7.0 MB'. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

/** Format a duration (ms) as a human freshness string, e.g. '5 分钟前'. */
export function formatDurationAgo(nowMs: number, thenMs: number): string | null {
  if (!Number.isFinite(nowMs) || !Number.isFinite(thenMs) || thenMs <= 0 || nowMs < thenMs) return null
  const sec = Math.floor((nowMs - thenMs) / 1000)
  if (sec < 60) return sec <= 1 ? '刚刚' : `${sec} 秒前`
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`
  return `${Math.floor(sec / 3600)} 小时前`
}

/** Sum an array of byte counts (per-workspace disk usage) into a single total. */
export function sumBytes(parts: readonly number[]): number {
  let total = 0
  for (const p of parts) total += p
  return total
}