// dsh-flash-mem-mon — HOST half of the memory monitor provider.
//
// Migrated from dock-flash/src/index.ts:
// - MemorySample interface (original :574-581)
// - GcStats interface (original :583-594)
// - MemoryTrendSummary interface (original :596-610)
// - MemoryTrendCollector class (original :612-820)
// - Module-level singleton _memoryTrend (original :823)
// - Memory trend collector bootstrap + dispose (original :834-848)
// - Volatile-update handler for poll intervals
// - GET /plugins/dsh-flash-mem-mon/memory-trend route (original :1873-1910)
// - sendJson() (original :537-542) and readJsonBody() (original :549-563)
//
// Route path changed from /plugins/dock-flash/memory-trend to
// /plugins/dsh-flash-mem-mon/memory-trend.  Settings namespace changed
// from 'dock-flash' to 'dsh-flash-mem-mon'.
//
// This half is ESM (`"type": "module"`, and DSH's own entry is ESM too), so
// `require` does not exist here — every host dependency is a static import
// declared in package.json.
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-settings'
import type { Volatile } from '@deepseek-ai/cordis'
// Default export only (`export default Schema`); there is no named `Schema`.
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-flash-mem-mon'

// No host-side service dependencies; all services are injected lazily.
export const inject: string[] = []

// ── Memory alert thresholds (RSS MB) and GC thresholds (major GC/min) ──

const DEFAULT_MEM_THRESHOLD_INFO = 256
const DEFAULT_MEM_THRESHOLD_WARNING = 512
const DEFAULT_MEM_THRESHOLD_ERROR = 1024
const DEFAULT_MEM_THRESHOLD_CRITICAL = 1536
const DEFAULT_MEM_POLL_BASE = 30000
const DEFAULT_MEM_POLL_MIN = 2000
const DEFAULT_GC_THRESHOLD_INFO = 2
const DEFAULT_GC_THRESHOLD_WARNING = 5
const DEFAULT_GC_THRESHOLD_ERROR = 10

/** Resolved volatile config — each field is a live reference read with .get(). */
export interface MemMonConfig {
  memThresholdInfo: Volatile<number>
  memThresholdWarning: Volatile<number>
  memThresholdError: Volatile<number>
  memThresholdCritical: Volatile<number>
  memPollBase: Volatile<number>
  memPollMin: Volatile<number>
  gcThresholdInfo: Volatile<number>
  gcThresholdWarning: Volatile<number>
  gcThresholdError: Volatile<number>
}

export const Config = Schema.object({
  memThresholdInfo: Schema.number().default(DEFAULT_MEM_THRESHOLD_INFO).volatile(),
  memThresholdWarning: Schema.number().default(DEFAULT_MEM_THRESHOLD_WARNING).volatile(),
  memThresholdError: Schema.number().default(DEFAULT_MEM_THRESHOLD_ERROR).volatile(),
  memThresholdCritical: Schema.number().default(DEFAULT_MEM_THRESHOLD_CRITICAL).volatile(),
  memPollBase: Schema.number().default(DEFAULT_MEM_POLL_BASE).volatile(),
  memPollMin: Schema.number().default(DEFAULT_MEM_POLL_MIN).volatile(),
  gcThresholdInfo: Schema.number().default(DEFAULT_GC_THRESHOLD_INFO).volatile(),
  gcThresholdWarning: Schema.number().default(DEFAULT_GC_THRESHOLD_WARNING).volatile(),
  gcThresholdError: Schema.number().default(DEFAULT_GC_THRESHOLD_ERROR).volatile(),
})

// ───────────────────────────────────────────────────────────────────────────
// Memory trend collector — host-side Node.js process memory ring buffer.
//
// Periodically samples `process.memoryUsage()` into a bounded ring buffer
// and exposes the history over an HTTP route for the client's panel to
// render trend sparklines / text summaries. The data is session-scoped:
// lost on restart, deliberately not durable.
// ───────────────────────────────────────────────────────────────────────────

interface MemorySample {
  ts: number
  rss: number
  heapTotal: number
  heapUsed: number
  external: number
  arrayBuffers: number
}

interface GcStats {
  /** Number of minor (Scavenge) GC cycles in the reporting window. */
  minorCount: number
  /** Number of major (MarkSweep/MarkCompact) GC cycles in the reporting window. */
  majorCount: number
  /** Major GC frequency (cycles per minute) over the reporting window. */
  majorPerMin: number
  /** Total GC pause time (ms) in the reporting window. */
  gcPauseMs: number
  /** GC pause rate (ms per minute) over the reporting window. */
  gcPausePerMin: number
}

interface MemoryTrendSummary {
  current: MemorySample | null
  peak: { heapUsed: number; rss: number; ts: number } | null
  /** Linear-regression slope direction over the most recent samples. */
  trend: 'up' | 'stable' | 'down'
  sampleCount: number
  /** Heap usage ratio of the latest sample (0–1). */
  heapRatio: number
  /** Interval in seconds between the first and last sample (0 if < 2). */
  spanSeconds: number
  /** RSS linear-regression slope per minute (MB/min). Positive = growing. */
  rssSlopePerMin: number
  /** GC statistics aggregated over the last ~5 minutes. */
  gc: GcStats | null
}

class MemoryTrendCollector {
  private _samples: MemorySample[] = []
  private _timer: ReturnType<typeof setInterval> | null = null
  private _cap: number

  // GC monitoring via PerformanceObserver
  private _gcObserver: any = null  // PerformanceObserver | null
  private _gcEvents: Array<{ ts: number; kind: number; duration: number }> = []
  private _gcEventsCap = 2000  // ~5 min at worst-case GC frequency
  /** Separate cap for major GC events only — they are rare and valuable for diagnostics. */
  private _gcMajorEvents: Array<{ ts: number; kind: number; duration: number }> = []
  private _gcMajorEventsCap = 500  // Full GC events are rare; keep up to 500 (~hours)

  constructor(cap = 720) {
    this._cap = Math.max(10, cap)
  }

  start(baseInterval = 30_000, minInterval = 5_000): void {
    this.stop()
    // Fire-and-forget: GC observer can start asynchronously; the poll loop
    // below begins immediately regardless, since it does not depend on GC.
    this._startGcObserver().catch(() => {})
    const poll = () => {
      const mu = process.memoryUsage()
      this._push({
        ts: Date.now(),
        rss: mu.rss,
        heapTotal: mu.heapTotal,
        heapUsed: mu.heapUsed,
        external: mu.external,
        arrayBuffers: mu.arrayBuffers,
      })
      // Adaptive: higher heap usage → shorter interval (sample more densely).
      const ratio = mu.heapUsed / mu.heapTotal
      const next = Math.max(minInterval, Math.round(baseInterval * Math.pow(1 - Math.min(ratio, 1), 2) + minInterval))
      this._timer = setTimeout(poll, next)
      // Unref so the timer never keeps the process alive on its own.
      if (this._timer && typeof this._timer === 'object' && 'unref' in this._timer) {
        this._timer.unref()
      }
    }
    // First sample immediately.
    poll()
  }

  stop(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer)
      this._timer = null
    }
    this._stopGcObserver()
  }

  setCap(cap: number): void {
    this._cap = Math.max(10, Math.floor(cap) || 10)
    while (this._samples.length > this._cap) this._samples.shift()
  }

  query(since?: number): MemorySample[] {
    if (!since) return this._samples.slice()
    return this._samples.filter(s => s.ts >= since)
  }

  /** Return recent GC events (last ~5 min) for chart rendering.
   *  Pass since=0 to return ALL stored events (for full-mode fetches). */
  gcEvents(since?: number): Array<{ ts: number; kind: number; duration: number }> {
    if (this._gcEvents.length === 0 && this._gcMajorEvents.length === 0) return []
    const cutoff = since ?? (Date.now() - 5 * 60 * 1000)
    // Merge the general ring buffer with the dedicated major-GC buffer
    const all = this._gcEvents.concat(this._gcMajorEvents)
    // Deduplicate by (ts, kind) — major events that also appear in the general buffer
    const seen = new Set<string>()
    const result: Array<{ ts: number; kind: number; duration: number }> = []
    for (const e of all) {
      if (e.ts < cutoff) continue
      const key = e.ts + '|' + e.kind + '|' + e.duration
      if (seen.has(key)) continue
      seen.add(key)
      result.push(e)
    }
    // Sort by timestamp for consistent rendering
    result.sort((a, b) => a.ts - b.ts)
    return result
  }

  summary(since?: number): MemoryTrendSummary {
    const data = this.query(since)
    if (data.length === 0) {
      return { current: null, peak: null, trend: 'stable', sampleCount: 0, heapRatio: 0, spanSeconds: 0, rssSlopePerMin: 0, gc: null }
    }
    const current = data[data.length - 1]
    let peak = { heapUsed: 0, rss: 0, ts: 0 }
    for (const s of data) {
      if (s.heapUsed > peak.heapUsed) peak = { heapUsed: s.heapUsed, rss: s.rss, ts: s.ts }
    }
    // Simple linear regression on heapUsed over the last 20 samples (or fewer).
    const tail = data.slice(-20)
    let trend: 'up' | 'stable' | 'down' = 'stable'
    if (tail.length >= 3) {
      const n = tail.length
      let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0
      for (let i = 0; i < n; i++) {
        sumX += i
        sumY += tail[i].heapUsed
        sumXY += i * tail[i].heapUsed
        sumXX += i * i
      }
      const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX)
      // Threshold: ±0.5% of current heapUsed per sample-index step.
      const threshold = current.heapUsed * 0.005
      if (slope > threshold) trend = 'up'
      else if (slope < -threshold) trend = 'down'
    }
    const heapRatio = current.heapTotal > 0 ? current.heapUsed / current.heapTotal : 0
    const spanSeconds = data.length >= 2 ? Math.round((data[data.length - 1].ts - data[0].ts) / 1000) : 0

    // RSS linear regression over the last 20 samples → slope per minute (MB/min).
    let rssSlopePerMin = 0
    if (tail.length >= 3) {
      const n = tail.length
      let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0
      for (let i = 0; i < n; i++) {
        sumX += i
        sumY += tail[i].rss
        sumXY += i * tail[i].rss
        sumXX += i * i
      }
      const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX)
      // slope = bytes per sample-index step.  Convert to MB/min.
      // Average interval between tail samples ≈ spanSeconds / (n-1).
      const avgIntervalSec = tail.length >= 2 ? spanSeconds / (tail.length - 1) : 30
      const samplesPerMin = avgIntervalSec > 0 ? 60 / avgIntervalSec : 2
      rssSlopePerMin = Math.round((slope * samplesPerMin / 1048576) * 100) / 100
    }

    // GC stats over the last ~5 minutes.
    const gc = this._gcSummary(5 * 60 * 1000)

    return { current, peak, trend, sampleCount: data.length, heapRatio, spanSeconds, rssSlopePerMin, gc }
  }

  /** Aggregate GC events in the last `windowMs` milliseconds. */
  private _gcSummary(windowMs: number): GcStats | null {
    if (this._gcEvents.length === 0) return null
    const cutoff = Date.now() - windowMs
    const recent = this._gcEvents.filter(e => e.ts >= cutoff)
    if (recent.length === 0) return null

    let minorCount = 0, majorCount = 0, gcPauseMs = 0
    for (const e of recent) {
      gcPauseMs += e.duration
      if (e.kind === 2) majorCount++       // kind=2 → major (MarkSweep/MarkCompact)
      else if (e.kind === 1) minorCount++   // kind=1 → minor (Scavenge)
      // kind=4 (incremental marking), kind=8 (weak callbacks) — counted in pause but not as cycles
    }

    const windowMin = windowMs / 60000
    return {
      minorCount,
      majorCount,
      majorPerMin: Math.round((majorCount / windowMin) * 100) / 100,
      gcPauseMs: Math.round(gcPauseMs * 100) / 100,
      gcPausePerMin: Math.round((gcPauseMs / windowMin) * 100) / 100,
    }
  }

  private async _startGcObserver(): Promise<void> {
    try {
      // Dynamic import — perf_hooks may not be available in all environments.
      // MUST use import(), not require(): this half is ESM, so require() throws
      // ReferenceError into the catch — silently disabling GC monitoring forever.
      const { PerformanceObserver } = await import('perf_hooks')
      this._gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          // GC entry kinds: 1=minor, 2=major, 4=incremental, 8=weak callbacks
          const kind = (entry as any).kind ?? 0
          const event = { ts: Date.now(), kind, duration: entry.duration }
          this._gcEvents.push(event)
          // Also store major (Full) GC events in a separate long-lived buffer,
          // because they are rare and the general ring buffer may evict them.
          if (kind === 2) {
            this._gcMajorEvents.push(event)
            while (this._gcMajorEvents.length > this._gcMajorEventsCap) this._gcMajorEvents.shift()
          }
        }
        // Cap the ring buffer.
        while (this._gcEvents.length > this._gcEventsCap) this._gcEvents.shift()
      })
      this._gcObserver.observe({ type: 'gc', buffered: true })
    } catch (_) {
      // GC observation not available — gc will remain null in summaries.
      this._gcObserver = null
    }
  }

  private _stopGcObserver(): void {
    if (this._gcObserver) {
      try { this._gcObserver.disconnect() } catch (_) {}
      this._gcObserver = null
    }
    this._gcEvents = []
    this._gcMajorEvents = []
  }

  private _push(s: MemorySample): void {
    this._samples.push(s)
    if (this._samples.length > this._cap) this._samples.shift()
  }
}

/** Module-level singleton — one collector per process. */
let _memoryTrend: MemoryTrendCollector | null = null

// ── Private HTTP helpers ────────────────────────────────────────────────

/** Send a JSON response with no-store cache control. */
function sendJson(res: ServerResponse, status: number, payload: any) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Read an optional JSON request body, bounded so a client cannot feed the
 * host an unbounded buffer. Returns null for an empty, oversized, or
 * unparseable body — callers treat that as "no override supplied".
 */
async function readJsonBody(req: IncomingMessage, limit = 4096): Promise<any> {
  try {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req as any) {
      size += (chunk as Buffer).length
      if (size > limit) return null
      chunks.push(chunk as Buffer)
    }
    if (chunks.length === 0) return null
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (_) {
    return null
  }
}

// ── apply() ─────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: MemMonConfig) {
  // ── Settings namespace registration ──────────────────────────────────
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
  })

  // ── Memory trend collector bootstrap ──────────────────────────────────
  // One bounded ring buffer per process. Starts on first apply and stops on
  // dispose. The timer uses .unref() so it never keeps the process alive.
  if (!_memoryTrend) _memoryTrend = new MemoryTrendCollector()
  _memoryTrend.start(
    (config.memPollBase?.get?.() ?? config.memPollBase) as number || DEFAULT_MEM_POLL_BASE,
    (config.memPollMin?.get?.()  ?? config.memPollMin)  as number || DEFAULT_MEM_POLL_MIN,
  )
  ctx.effect(() => {
    const collector = _memoryTrend
    return () => {
      collector?.stop()
      _memoryTrend = null
    }
  })

  // ── Volatile-update handler for poll intervals ────────────────────────
  // Restart the collector when memPollBase or memPollMin change.
  ctx.on('loader/volatile-update' as any, (paths: string[][]) => {
    const memPaths = ['memPollBase', 'memPollMin']
    if (!paths.some((pp) => pp.length && memPaths.includes(pp[pp.length - 1]))) return
    if (_memoryTrend) {
      _memoryTrend.stop()
      _memoryTrend.start(
        (config.memPollBase?.get?.() ?? config.memPollBase) as number || DEFAULT_MEM_POLL_BASE,
        (config.memPollMin?.get?.()  ?? config.memPollMin)  as number || DEFAULT_MEM_POLL_MIN,
      )
    }
  })

  // ── HTTP API route for client-side trend data ────────────────────────
  // The webServer type augmentation lives in @deepseek-ai/dsh-host-webserver
  // which is not a direct dependency; cast through `any` for the register calls.
  ctx.inject(['webServer'], (wsCtx: any) => {
    // GET /plugins/dsh-flash-mem-mon/memory-trend
    // Returns memory trend data for the client's config popup.
    // `mode=summary` returns a lightweight snapshot (current, peak, trend direction);
    // `mode=full` returns the raw samples for rendering a chart.
    // Optional `since` (unix ms) limits the range.
    wsCtx.effect(() => wsCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-flash-mem-mon/memory-trend',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.setHeader('allow', 'GET')
          res.end()
          return
        }
        if (!_memoryTrend) {
          sendJson(res, 200, { samples: [], summary: null })
          return
        }
        const u = new URL(req.url || '/', 'http://localhost')
        const since = parseInt(u.searchParams.get('since') || '0', 10) || 0
        const mode = u.searchParams.get('mode') || 'summary'
        if (mode === 'full') {
          // For gcEvents: when no explicit `since` is requested (since=0),
          // pass 0 so ALL stored events are returned — not just the last 5 min.
          // gcEvents(0) → cutoff=0 → returns everything.
          // gcEvents(undefined) → cutoff=now-5min → only recent events.
          // The sparkline may span hours, so we need the full range.
          const gcSince = since > 0 ? since : 0
          // Only return major (Full) GC events to the client — minor GC
          // is too frequent and clutters the chart.  Minor GC stats are
          // still available via mode=summary (majorPerMin, gcPausePerMin).
          const allGcEvents = _memoryTrend.gcEvents(gcSince)
          const majorGcEvents = allGcEvents.filter(e => e.kind === 2)
          sendJson(res, 200, {
            samples: _memoryTrend.query(since || undefined),
            gcEvents: majorGcEvents,
          })
        } else {
          sendJson(res, 200, _memoryTrend.summary(since || undefined))
        }
      },
    }), 'dsh-flash-mem-mon: GET /plugins/dsh-flash-mem-mon/memory-trend')
  })
}
