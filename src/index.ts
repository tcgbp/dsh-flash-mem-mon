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
// - sendJson() (original :537-542)
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
import { writeHeapSnapshot } from 'node:v8'
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
// Default export only (`export default Schema`); there is no named `Schema`.
import Schema from '@deepseek-ai/schemastery'
import {
  countArchivedSessions,
  DEFAULT_ALERT_CONFIG,
  formatBytes,
  isFullGc,
  rssSlopePerMin,
  sumBytes,
} from './pure.js'

export const name = 'dsh-flash-mem-mon'

// ── Minimal structural type for the host webserver service ─────────────
// The full type augmentation lives in @deepseek-ai/dsh-host-webserver, which is
// not a compile-time dependency here (see package.json peerDependencies). We
// only use register({kind:'exact', path, handler}), so we declare a narrow
// structural shape instead of casting the whole ctx to `any`. The webServer
// object actually injected at runtime has the same register signature.
type HttpHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
interface HostWebServerRegisterInput {
  kind: 'exact' | 'prefix' | 'fallback'
  path: string
  handler: HttpHandler
}
interface HostWebServer {
  /** Register a route; returns a disposer to unregister it. */
  register(input: HostWebServerRegisterInput): () => void
}

// Lazy-injected services. All are resolved via ctx.inject() at apply-time, so
// the plugin still boots even when a service (e.g. workspaceRegistry) is
// unavailable; declaring them here documents the dependency.
export const inject: string[] = ['workspaceRegistry']

// ── Memory alert thresholds (RSS MB) and GC thresholds (major GC/min) ──
// All values come from the single canonical DEFAULT_ALERT_CONFIG in
// ./pure.js. The browser client half mirrors these (see lib/client.js
// _MEM_ALERT_DEFAULTS); test/defaults-drift.test.ts guarantees they never
// drift from this source of truth.

const DEFAULT_MEM_THRESHOLD_INFO = DEFAULT_ALERT_CONFIG.memThresholdInfo
const DEFAULT_MEM_THRESHOLD_WARNING = DEFAULT_ALERT_CONFIG.memThresholdWarning
const DEFAULT_MEM_THRESHOLD_ERROR = DEFAULT_ALERT_CONFIG.memThresholdError
const DEFAULT_MEM_THRESHOLD_CRITICAL = DEFAULT_ALERT_CONFIG.memThresholdCritical
const DEFAULT_MEM_POLL_BASE = DEFAULT_ALERT_CONFIG.memPollBase
const DEFAULT_MEM_POLL_MIN = DEFAULT_ALERT_CONFIG.memPollMin
const DEFAULT_GC_THRESHOLD_INFO = DEFAULT_ALERT_CONFIG.gcThresholdInfo
const DEFAULT_GC_THRESHOLD_WARNING = DEFAULT_ALERT_CONFIG.gcThresholdWarning
const DEFAULT_GC_THRESHOLD_ERROR = DEFAULT_ALERT_CONFIG.gcThresholdError
const DEFAULT_MEM_GROWTH_ALERT_PER_MIN = DEFAULT_ALERT_CONFIG.memGrowthAlertPerMin

// Session-footprint (disk) polling interval. Deliberately NOT a member of
// DEFAULT_ALERT_CONFIG: test/defaults-drift.test.ts asserts that object contains
// EXACTLY the 10 memory/GC keys, and a footprint key here would break that
// precise set. Disk scans are comparatively expensive (recursive readdir +
// stat over every session directory), so they run far less often than memory.
// The host caches the last scan and the client reads the cached snapshot, so
// the route itself never triggers an on-demand scan.
const FOOTPRINT_POLL_INTERVAL_MS = 300000  // 5 min

/**
 * Sentinel passed to `query()` / `gcEvents()` as the `since` lower bound to
 * mean "no lower bound — return ALL stored records".  These methods treat any
 * `since <= 0` (0 or undefined) as "all", and a positive value as a unix-ms
 * timestamp to filter from.  Keeping one explicit convention prevents callers
 * from mixing up `0` vs `undefined` (both mean "all").
 */
const SINCE_ALL = 0

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
  memGrowthAlertPerMin: Volatile<number>
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
  memGrowthAlertPerMin: Schema.number().default(DEFAULT_MEM_GROWTH_ALERT_PER_MIN).volatile(),
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
  /** Interval in MILLISECONDS between the first and last sample (0 if < 2). */
  spanMs: number
  /** RSS linear-regression slope per minute (MB/min). Positive = growing. */
  rssSlopePerMin: number
  /** GC statistics aggregated over the last ~5 minutes. */
  gc: GcStats | null
}

class MemoryTrendCollector {
  private _samples: MemorySample[] = []
  // The poll loop is self-scheduling via setInterval-like recursion with an
  // ADAPTIVE delay (higher heap usage → shorter interval), so each cycle holds
  // a fresh setTimeout handle rather than one fixed-interval setInterval.
  private _timer: ReturnType<typeof setTimeout> | null = null
  /** Monotonic loop generation. Bumped every start()/stop(); a poll() tick
   *  whose captured generation no longer matches the current one is a stale
   *  callback from a superseded loop and must NOT re-schedule itself. This
   *  closes the start/stop restart race where a queued pre-restart tick could
   *  otherwise clobber the new loop's timer handle and leak a second loop. */
  private _generation = 0
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
    const gen = ++this._generation
    // Fire-and-forget: GC observer can start asynchronously; the poll loop
    // below begins immediately regardless, since it does not depend on GC.
    this._startGcObserver().catch(() => {})
    const poll = () => {
      // Bail if this tick belongs to a superseded loop (a restart has bumped
      // the generation since we were scheduled). The stopped loop then winds
      // down on its own instead of fighting the fresh loop for this._timer.
      if (gen !== this._generation) return
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
    // Bump the generation BEFORE clearing so any in-flight/stale poll tick that
    // is already queued (past clearTimeout's reach) recognises itself as stale
    // and refuses to re-schedule, never resurrecting a stopped loop.
    this._generation++
    if (this._timer !== null) {
      clearTimeout(this._timer)
      this._timer = null
    }
    this._stopGcObserver()
  }

  /** Memory samples at or after `since` (unix ms). A falsy/absent `since`
   *  (`SINCE_ALL` / undefined) means "return all stored samples". */
  query(since: number = SINCE_ALL): MemorySample[] {
    if (since <= 0) return this._samples.slice()
    return this._samples.filter(s => s.ts >= since)
  }

  /** Return Full (major) GC events for chart rendering.
   *  Each returned event is one real full-GC cycle (phases already coalesced
   *  in `_startGcObserver`) and is normalized to kind=2 so the client can
   *  always treat `gcEvents` as "Full GC events".  A falsy/absent `since`
   *  (`SINCE_ALL` / undefined) means "return all stored events". */
  gcEvents(since: number = SINCE_ALL): Array<{ ts: number; kind: number; duration: number }> {
    if (this._gcMajorEvents.length === 0) return []
    const events = since > 0
      ? this._gcMajorEvents.filter(e => e.ts >= since)
      : this._gcMajorEvents
    return events
      .map(e => ({ ts: e.ts, kind: 2, duration: e.duration }))
      .sort((a, b) => a.ts - b.ts)
  }

  summary(since?: number): MemoryTrendSummary {
    const data = this.query(since)
    if (data.length === 0) {
      return { current: null, peak: null, trend: 'stable', sampleCount: 0, heapRatio: 0, spanMs: 0, rssSlopePerMin: 0, gc: null }
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
    const spanMs = data.length >= 2 ? data[data.length - 1].ts - data[0].ts : 0

    // RSS linear-regression slope per minute (MB/min); positive = growing.
    // Delegated to the pure helper (src/pure.ts) so the same logic is unit-
    // tested. The average interval comes from the tail's own time span — see
    // rssSlopePerMin for why using the whole buffer span would under-report.
    const rssSlope = rssSlopePerMin(data)

    // GC stats over the last ~5 minutes.
    const gc = this._gcSummary(5 * 60 * 1000)

    return { current, peak, trend, sampleCount: data.length, heapRatio, spanMs, rssSlopePerMin: rssSlope, gc }
  }

  /** Aggregate GC events in the last `windowMs` milliseconds. */
  private _gcSummary(windowMs: number): GcStats | null {
    if (this._gcEvents.length === 0 && this._gcMajorEvents.length === 0) return null
    const cutoff = Date.now() - windowMs

    // Major (Full) count comes from the coalesced major-GC buffer so each
    // real cycle counts once (not once per phase entry).
    const majorRecent = this._gcMajorEvents.filter(e => e.ts >= cutoff)
    const majorCount = majorRecent.length

    // Minor count + total pause come from the general ring buffer (which holds
    // EVERY PerformanceObserver entry). A minor cycle is a Scavenge (kind bit 1
    // set). NOTE: gcPauseMs is the SUM of every phase-entry duration in the
    // window — one real Full GC is reported as multiple phases (kind 4 + 8), and
    // each contributes its own duration, so gcPauseMs is the TOTAL stop-the-world
    // pause across all cycles (minor + full), NOT per-cycle. majorCount, by
    // contrast, comes from the separate coalesced buffer and counts each real
    // Full GC cycle ONCE. The two buffers intentionally have different semantics:
    // majorCount = distinct full collections; gcPauseMs = aggregate pauses.
    let minorCount = 0, gcPauseMs = 0
    for (const e of this._gcEvents) {
      if (e.ts < cutoff) continue
      gcPauseMs += e.duration
      if ((e.kind & 1) !== 0) minorCount++
    }
    if (majorCount === 0 && minorCount === 0 && gcPauseMs === 0) return null

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
          // GC entry kinds form a bitmask (see isFullGc): 1=Scavenge(minor),
          // 2/4/8 = MarkSweepCompact/IncrementalMarking/ProcessWeakCallbacks.
          // A single real Full GC is usually reported as several phase entries
          // (e.g. kind 4 + kind 8) within a few ms, so we coalesce them into
          // one Full GC event below.
          const kind = (entry as any).kind ?? 0
          const event = { ts: Date.now(), kind, duration: entry.duration }
          this._gcEvents.push(event)
          // Also store full (major) GC events in a separate long-lived buffer,
          // because they are rare and the general ring buffer may evict them.
          if (isFullGc(kind)) {
            const last = this._gcMajorEvents[this._gcMajorEvents.length - 1]
            if (last && event.ts - last.ts < 500) {
              // Same full-GC cycle (phase entries arriving back-to-back):
              // merge into the existing event, keeping the worst-case pause.
              last.duration = Math.max(last.duration, event.duration)
              last.ts = event.ts
            } else {
              this._gcMajorEvents.push(event)
              while (this._gcMajorEvents.length > this._gcMajorEventsCap) this._gcMajorEvents.shift()
            }
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

// ── Process-scoped singleton with an exclusive active owner ─────────────
//
// A single MemoryTrendCollector is shared across the whole process so all
// consumers see one coherent ring buffer (each sample carries its own ts).
// However, Cordis may apply() this plugin more than once (multiple profiles,
// hot reload) and dispose() them in any order. To avoid two collectors racing
// on the same module state — and to stop one stray dispose() from killing a
// collector another apply() is still using — ownership is explicit:
//
//   _memoryTrend  : the live collector (or null)
//   _ownerCtx     : the Context that currently owns it (or null)
//
// startTrend()/stopTrend() are idempotent and fail softly when the caller is
// not the current owner, so overlapping apply/dispose cycles stay safe.
let _memoryTrend: MemoryTrendCollector | null = null
let _ownerCtx: Context | null = null

// ── Heap-snapshot dump state ─────────────────────────────────────────────
// The "dump heap now" disposal button on an alert POSTs dump-heap, which
// writes a .heapsnapshot (possibly tens–hundreds of MB) and records it here
// so the browser client can pull it down via the heap-dump route. Only the
// latest snapshot is kept for download; dumps are user-paced, not automatic,
// because writeHeapSnapshot() blocks the host main thread for seconds.
let _lastSnapshot: { name: string; path: string; size: number } | null = null

/** Adopt the process-wide collector for `ctx`; no-op if it is already owned. */
function startTrend(ctx: Context, config: MemMonConfig): void {
  if (_ownerCtx && _ownerCtx !== ctx) return  // someone else owns it
  if (!_memoryTrend) _memoryTrend = new MemoryTrendCollector()
  _ownerCtx = ctx
  _memoryTrend.start(
    (config.memPollBase?.get?.() ?? config.memPollBase) as number || DEFAULT_MEM_POLL_BASE,
    (config.memPollMin?.get?.()  ?? config.memPollMin)  as number || DEFAULT_MEM_POLL_MIN,
  )
}

function restartTrend(config: MemMonConfig): void {
  if (!_memoryTrend || !_ownerCtx) return
  _memoryTrend.stop()
  _memoryTrend.start(
    (config.memPollBase?.get?.() ?? config.memPollBase) as number || DEFAULT_MEM_POLL_BASE,
    (config.memPollMin?.get?.()  ?? config.memPollMin)  as number || DEFAULT_MEM_POLL_MIN,
  )
}

/** Relinquish ownership of `ctx`. Only the active owner may stop the shared
 *  collector; other ctx instances (already superseded) must not touch it. */
function stopTrend(ctx: Context): void {
  if (_ownerCtx !== ctx) return  // not the owner → leave the running collector alone
  _ownerCtx = null
  _memoryTrend?.stop()
}

// ── Session-footprint collector ─────────────────────────────────────────
//
// Answers "how big is my session footprint?" — total session count, archived
// session count, and on-disk usage under <DSH_HOME>/sessions. The data is
// structural (directory listings + sizes), not high-frequency, and a recursive
// scan is comparatively expensive, so this runs on its own slow cadence and
// caches the latest snapshot for the HTTP route to serve on demand.
//
// The count of ARCHIVED sessions comes from the DSH runtime's
// workspaceRegistry.archivedSessionIds (the same truth the workspace manager
// uses) intersected with the on-disk session directories: an id counts as an
// archived session only if its directory still exists. This keeps the number
// faithful to the runtime even if some archived sessions were pruned from disk.
//
// Ownership follows the MemoryTrendCollector singleton pattern (idempotent
// start/stopGuarded start/stop, single owner) so overlapping apply/dispose
// cycles cannot double-scan or kill a live collector prematurely.

export interface FootprintWorkspace {
  workspace: string            // directory name (slug form)
  totalSessions: number
  archivedSessions: number
  bytes: number                // on-disk bytes for this workspace's sessions
}
export interface SessionFootprint {
  totalSessions: number
  archivedSessions: number
  bytes: number                // total on-disk bytes across all workspaces
  workspaces: FootprintWorkspace[]
  scannedAt: number            // unix ms of the last successful scan (0 if none)
}

class SessionFootprintCollector {
  private _snapshot: SessionFootprint | null = null
  private _timer: ReturnType<typeof setTimeout> | null = null
  private _running = false

  start(): void {
    if (this._running) return
    this._running = true
    this._scan().then(() => { this._schedule() }).catch(() => { this._schedule() })
  }

  stop(): void {
    this._running = false
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
  }

  /** Immediately trigger a re-scan (e.g. right after the workspace registry is
   *  captured) so the very first archived count is not stuck at 0. */
  rescan(): void {
    if (!this._running) return
    this._scan().catch(() => { /* keep last snapshot */ })
  }

  snapshot(): SessionFootprint | null {
    return this._snapshot
  }

  private _schedule(): void {
    if (!this._running) return
    this._timer = setTimeout(() => {
      this._timer = null
      this._scan().then(() => { this._schedule() }).catch(() => { this._schedule() })
    }, FOOTPRINT_POLL_INTERVAL_MS)
    this._timer.unref?.()
  }

  private async _scan(): Promise<void> {
    const sessionsRoot = resolveSessionsRoot()

    const workspaces = await this._scanWorkspaces(sessionsRoot)
    const snapshot: SessionFootprint = {
      totalSessions: 0,
      archivedSessions: 0,
      bytes: 0,
      workspaces,
      scannedAt: Date.now(),
    }
    for (const w of workspaces) {
      snapshot.totalSessions += w.totalSessions
      snapshot.archivedSessions += w.archivedSessions
      snapshot.bytes += w.bytes
    }
    this._snapshot = snapshot
  }

  private async _scanWorkspaces(sessionsRoot: string): Promise<FootprintWorkspace[]> {
    let workspaceDirs: string[] = []
    try {
      workspaceDirs = await readdir(sessionsRoot, { withFileTypes: true }).then(
        (ents) => ents.filter((e) => e.isDirectory()).map((e) => e.name),
      )
    } catch (_e) {
      return []
    }
    const registry = getWorkspaceRegistry()
    let archivedIds: string[] = []
    try {
      if (registry && typeof registry.archivedSessionIds === 'function') archivedIds = registry.archivedSessionIds()
      else if (registry && Array.isArray((registry as any).archivedSessionIds)) archivedIds = (registry as any).archivedSessionIds as string[]
    } catch (_e) { /* keep empty */ }

    const result: FootprintWorkspace[] = []
    for (const ws of workspaceDirs) {
      const wsPath = join(sessionsRoot, ws)
      let sessionNames: string[] = []
      try {
        sessionNames = await readdir(wsPath, { withFileTypes: true }).then(
          (ents) => ents.filter((e) => e.isDirectory() && /^session-/.test(e.name)).map((e) => e.name),
        )
      } catch (_e) {
        sessionNames = []
      }
      const namesSet = new Set(sessionNames)
      let bytes = 0
      for (const s of sessionNames) {
        bytes += await dirSize(join(wsPath, s))
      }
      result.push({
        workspace: ws,
        totalSessions: sessionNames.length,
        archivedSessions: countArchivedSessions(archivedIds, namesSet),
        bytes,
      })
    }
    return result
  }
}

/** Recursively sum the on-disk size of a session directory. */
async function dirSize(dir: string): Promise<number> {
  let total = 0
  let entries: import('node:fs').Dirent[] = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (_e) {
    return 0
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    try {
      if (e.isDirectory()) {
        total += await dirSize(p)
      } else if (e.isSymbolicLink()) {
        continue
      } else {
        const s = await stat(p)
        total += s.size
      }
    } catch (_e) { /* skip */ }
  }
  return total
}

/**
 * Resolve the DSH sessions root the same way the harness seeds `$DSH_HOME`:
 * configured override > `$DSH_HOME` env > `~/.dsh` (opened home). `$DSH_HOME`
 * may itself contain a `~` or trailing slashes, so expand the home and join the
 * well-known `sessions` sub-directory explicitly. Returns `''` if a home could
 * not be resolved at all (the scan then simply reports zero workspaces).
 */
function resolveSessionsRoot(): string {
  const env = process.env.DSH_HOME
  const home = env && env.trim()
    ? env.replace(/^~(?=\/|\\)/, homedir())
    : join(homedir(), '.dsh')
  return join(home, 'sessions')
}

let _footprint: SessionFootprintCollector | null = null
let _footprintOwner: Context | null = null

// Cached reference to the DSH workspace-registry service, resolved lazily via
// ctx.inject. When it is unavailable (or the plugin was applied without it),
// archived-session counting degrades to whatever the registry can provide —
// if the registry is truly absent the archived count is reported as 0 rather
// than guessing from the disk (disk directories carry no archive flag).
let _workspaceRegistry: any = null

function setWorkspaceRegistry(wsCtx: Context): void {
  const reg = (wsCtx as any)?.workspaceRegistry
  if (reg != null) _workspaceRegistry = reg
}

function getWorkspaceRegistry(): any {
  return _workspaceRegistry ?? null
}

function startFootprint(ctx: Context): void {
  if (_footprintOwner && _footprintOwner !== ctx) return
  if (!_footprint) _footprint = new SessionFootprintCollector()
  _footprintOwner = ctx
  _footprint.start()
}

function stopFootprint(ctx: Context): void {
  if (_footprintOwner !== ctx) return
  _footprintOwner = null
  _footprint?.stop()
}

// ── Private HTTP helpers ────────────────────────────────────────────────

/** Send a JSON response with no-store cache control. */
function sendJson(res: ServerResponse, status: number, payload: any) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

// ── apply() ─────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: MemMonConfig) {
  // ── Settings namespace registration ──────────────────────────────────
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
  })

  // ── Workspace-registry capture ───────────────────────────────────────
  // Grab the runtime's archived-session id list so the footprint collector can
  // intersect it with on-disk session dirs. The registry is injected lazily;
  // if it is unavailable at apply-time the footprint still scans the disk (and
  // simply reports the archived count from whatever the registry later yields,
  // or 0 if it never appears).
  ctx.inject(['workspaceRegistry'], (regCtx: Context) => {
    setWorkspaceRegistry(regCtx)
    // The registry may arrive after the collector's first scan already ran
    // with no archived ids → refresh it immediately so the count is correct.
    _footprint?.rescan()
  })

  // ── Session-footprint collector bootstrap ────────────────────────────
  // Low-frequency disk scan (5-minute cadence by default), cached on the host.
  // Owned exclusively by this ctx; overlapping apply/dispose cycles are safe.
  startFootprint(ctx)
  ctx.effect(() => {
    const owner = ctx
    return () => { stopFootprint(owner) }
  }, 'dsh-flash-mem-mon: session-footprint collector lifecycle')

  // ── Memory trend collector bootstrap ──────────────────────────────────
  // One bounded ring buffer per process, owned exclusively by the active ctx.
  // startTrend/stopTrend are idempotent and owner-guarded, so overlapping
  // apply/dispose cycles never double-start or kill a still-live collector.
  startTrend(ctx, config)
  ctx.effect(() => {
    const owner = ctx
    return () => { stopTrend(owner) }
  }, 'dsh-flash-mem-mon: memory-trend collector lifecycle')

  // ── Volatile-update handler for poll intervals ────────────────────────
  // Restart the collector when memPollBase or memPollMin change.
  ctx.on('loader/volatile-update' as any, (paths: string[][]) => {
    const memPaths = ['memPollBase', 'memPollMin']
    if (!paths.some((pp) => pp.length && memPaths.includes(pp[pp.length - 1]))) return
    restartTrend(config)
  })

  // ── HTTP API route for client-side trend data ────────────────────────
  // Uses a structural HostWebServer type instead of `any`. cordis's inject()
  // callback is statically typed as Context (the real webServer augmentation
  // lives in @deepseek-ai/dsh-host-webserver, not a compile-time dep here), so
  // the injected service is read through one narrow cast inside the callback —
  // when inject(keys) fires, the service is guaranteed present — then used
  // under the strong HostWebServer type for the whole register/effect block.
  ctx.inject(['webServer'], (wsCtx: Context) => {
    const ws = (wsCtx as any).webServer as HostWebServer
    // GET /plugins/dsh-flash-mem-mon/memory-trend
    // Returns memory trend data for the client's config popup.
    // `mode=summary` returns a lightweight snapshot (current, peak, trend direction);
    // `mode=full` returns the raw samples for rendering a chart.
    // Optional `since` (unix ms) limits the range.
    wsCtx.effect(() => ws.register({
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
          // `since` is already >= 0 here; 0 means "entire range" (SINCE_ALL),
          // so both `query` and `gcEvents` share the same bounds convention.
          // Only full (major) GC events are sent — minor GC is too frequent
          // and clutters the chart.  These are already coalesced into one
          // event per real cycle by `_startGcObserver`.  Minor GC stats are
          // still available via mode=summary (majorPerMin, gcPausePerMin).
          const majorGcEvents = _memoryTrend.gcEvents(since)
          sendJson(res, 200, {
            samples: _memoryTrend.query(since),
            gcEvents: majorGcEvents,
          })
        } else {
          sendJson(res, 200, _memoryTrend.summary(since))
        }
      },
    }), 'dsh-flash-mem-mon: GET /plugins/dsh-flash-mem-mon/memory-trend')

    // GET /plugins/dsh-flash-mem-mon/session-footprint
    // Returns the host's cached session-footprint snapshot (total / archived
    // session counts + per-workspace and total on-disk bytes). Serves only the
    // cached result of the low-frequency disk scan — never triggers a scan on
    // demand, so repeated client polls (or a reload while the modal is open)
    // cannot hammer the filesystem. `scannedAt` is the unix-ms time of the last
    // completed scan (0 before the first scan finishes).
    wsCtx.effect(() => ws.register({
      kind: 'exact',
      path: '/plugins/dsh-flash-mem-mon/session-footprint',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.setHeader('allow', 'GET')
          res.end()
          return
        }
        const snap = _footprint?.snapshot() ?? null
        sendJson(res, 200, snap ?? {
          totalSessions: 0,
          archivedSessions: 0,
          bytes: 0,
          workspaces: [],
          scannedAt: 0,
        })
      },
    }), 'dsh-flash-mem-mon: GET /plugins/dsh-flash-mem-mon/session-footprint')

    // POST /plugins/dsh-flash-mem-mon/dump-heap
    // Triggered by the "立即转储堆快照" disposal button attached to a memory
    // alert (see lib/client.js createHostMemoryAlertProvider → actions).
    // Synchronously writes a .heapsnapshot into the OS temp dir (the one
    // acceptable place to block the main thread: the user asked for it), then
    // records it as the latest snapshot and returns its name+size so the
    // client can confirm and pull it down. Auto-dump is deliberately NOT
    // offered anywhere — a runaway gleaning loop must never stall the host.
    wsCtx.effect(() => ws.register({
      kind: 'exact',
      path: '/plugins/dsh-flash-mem-mon/dump-heap',
      handler: async (_req: IncomingMessage, res: ServerResponse) => {
        if (_req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('allow', 'POST')
          res.end()
          return
        }
        const name = `dsh-flash-mem-mon-${Date.now()}.${process.pid}.heapsnapshot`
        const path = join(tmpdir(), name)
        try {
          writeHeapSnapshot(path)
          const info = await stat(path)
          _lastSnapshot = { name, path, size: info.size }
          sendJson(res, 200, { ok: true, name, size: info.size, path })
        } catch (err: any) {
          sendJson(res, 500, { ok: false, error: (err && err.message) || 'heap snapshot failed' })
        }
      },
    }), 'dsh-flash-mem-mon: POST /plugins/dsh-flash-mem-mon/dump-heap')

    // GET /plugins/dsh-flash-mem-mon/heap-dump
    // Streams the most recent heap snapshot back to the client as an
    // attachment. One latest-at-a-time is fine here: dumps are user-paced and
    // downloading is immediate, so keeping a whole archive is unnecessary
    // (and the tmp files are already pruned by the OS over time).
    wsCtx.effect(() => ws.register({
      kind: 'exact',
      path: '/plugins/dsh-flash-mem-mon/heap-dump',
      handler: async (_req: IncomingMessage, res: ServerResponse) => {
        if (_req.method !== 'GET') {
          res.statusCode = 405
          res.setHeader('allow', 'GET')
          res.end()
          return
        }
        const snap = _lastSnapshot
        if (!snap) {
          sendJson(res, 404, { error: 'No heap snapshot available yet' })
          return
        }
        try {
          await stat(snap.path)  // ensure it still exists
          res.statusCode = 200
          res.setHeader('content-type', 'application/octet-stream')
          res.setHeader('content-length', String(snap.size))
          res.setHeader('content-disposition', `attachment; filename="${snap.name}"`)
          res.setHeader('cache-control', 'no-store')
          createReadStream(snap.path).pipe(res)
        } catch (_e) {
          _lastSnapshot = null  // stale entry; drop it
          sendJson(res, 404, { error: 'Heap snapshot no longer available' })
        }
      },
    }), 'dsh-flash-mem-mon: GET /plugins/dsh-flash-mem-mon/heap-dump')
  })
}
