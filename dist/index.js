// Default export only (`export default Schema`); there is no named `Schema`.
import Schema from '@deepseek-ai/schemastery';
export const name = 'dsh-flash-mem-mon';
// No host-side service dependencies; all services are injected lazily.
export const inject = [];
// ── Memory alert thresholds (RSS MB) and GC thresholds (major GC/min) ──
const DEFAULT_MEM_THRESHOLD_INFO = 256;
const DEFAULT_MEM_THRESHOLD_WARNING = 512;
const DEFAULT_MEM_THRESHOLD_ERROR = 1024;
const DEFAULT_MEM_THRESHOLD_CRITICAL = 1536;
const DEFAULT_MEM_POLL_BASE = 30000;
const DEFAULT_MEM_POLL_MIN = 2000;
const DEFAULT_GC_THRESHOLD_INFO = 2;
const DEFAULT_GC_THRESHOLD_WARNING = 5;
const DEFAULT_GC_THRESHOLD_ERROR = 10;
// V8 GC entry `kind` is a bitmask of GC types:
//   1 << 0 = Scavenge (minor / young-gen)
//   1 << 1 = MarkSweepCompact (major / full)
//   1 << 2 = IncrementalMarking
//   1 << 3 = ProcessWeakCallbacks
// In practice modern V8/Node reports a full MarkSweepCompact cycle through the
// IncrementalMarking (4) and ProcessWeakCallbacks (8) phases — the standalone
// "major" bit (2) is almost never emitted on its own.  Classifying Full GC by
// `kind === 2` alone therefore misses (nearly) every real full collection.
// The robust test: a Full GC is any NON-scavenge cycle, i.e. the Scavenge bit
// (1) is NOT set.  This captures 2, 4, 6, 8, 10, 12, 14 while excluding minor
// (1) scavenges.
function isFullGc(kind) {
    return (kind & 1) === 0 && kind > 0;
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
});
class MemoryTrendCollector {
    _samples = [];
    _timer = null;
    _cap;
    // GC monitoring via PerformanceObserver
    _gcObserver = null; // PerformanceObserver | null
    _gcEvents = [];
    _gcEventsCap = 2000; // ~5 min at worst-case GC frequency
    /** Separate cap for major GC events only — they are rare and valuable for diagnostics. */
    _gcMajorEvents = [];
    _gcMajorEventsCap = 500; // Full GC events are rare; keep up to 500 (~hours)
    constructor(cap = 720) {
        this._cap = Math.max(10, cap);
    }
    start(baseInterval = 30_000, minInterval = 5_000) {
        this.stop();
        // Fire-and-forget: GC observer can start asynchronously; the poll loop
        // below begins immediately regardless, since it does not depend on GC.
        this._startGcObserver().catch(() => { });
        const poll = () => {
            const mu = process.memoryUsage();
            this._push({
                ts: Date.now(),
                rss: mu.rss,
                heapTotal: mu.heapTotal,
                heapUsed: mu.heapUsed,
                external: mu.external,
                arrayBuffers: mu.arrayBuffers,
            });
            // Adaptive: higher heap usage → shorter interval (sample more densely).
            const ratio = mu.heapUsed / mu.heapTotal;
            const next = Math.max(minInterval, Math.round(baseInterval * Math.pow(1 - Math.min(ratio, 1), 2) + minInterval));
            this._timer = setTimeout(poll, next);
            // Unref so the timer never keeps the process alive on its own.
            if (this._timer && typeof this._timer === 'object' && 'unref' in this._timer) {
                this._timer.unref();
            }
        };
        // First sample immediately.
        poll();
    }
    stop() {
        if (this._timer !== null) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        this._stopGcObserver();
    }
    setCap(cap) {
        this._cap = Math.max(10, Math.floor(cap) || 10);
        while (this._samples.length > this._cap)
            this._samples.shift();
    }
    query(since) {
        if (!since)
            return this._samples.slice();
        return this._samples.filter(s => s.ts >= since);
    }
    /** Return Full (major) GC events for chart rendering.
     *  Pass since=0 to return ALL stored events (for full-mode fetches).
     *  Each returned event is one real full-GC cycle (phases already coalesced
     *  in `_startGcObserver`) and is normalized to kind=2 so the client can
     *  always treat `gcEvents` as "Full GC events". */
    gcEvents(since) {
        if (this._gcMajorEvents.length === 0)
            return [];
        const cutoff = since ?? (Date.now() - 5 * 60 * 1000);
        return this._gcMajorEvents
            .filter(e => e.ts >= cutoff)
            .map(e => ({ ts: e.ts, kind: 2, duration: e.duration }))
            .sort((a, b) => a.ts - b.ts);
    }
    summary(since) {
        const data = this.query(since);
        if (data.length === 0) {
            return { current: null, peak: null, trend: 'stable', sampleCount: 0, heapRatio: 0, spanSeconds: 0, rssSlopePerMin: 0, gc: null };
        }
        const current = data[data.length - 1];
        let peak = { heapUsed: 0, rss: 0, ts: 0 };
        for (const s of data) {
            if (s.heapUsed > peak.heapUsed)
                peak = { heapUsed: s.heapUsed, rss: s.rss, ts: s.ts };
        }
        // Simple linear regression on heapUsed over the last 20 samples (or fewer).
        const tail = data.slice(-20);
        let trend = 'stable';
        if (tail.length >= 3) {
            const n = tail.length;
            let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
            for (let i = 0; i < n; i++) {
                sumX += i;
                sumY += tail[i].heapUsed;
                sumXY += i * tail[i].heapUsed;
                sumXX += i * i;
            }
            const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
            // Threshold: ±0.5% of current heapUsed per sample-index step.
            const threshold = current.heapUsed * 0.005;
            if (slope > threshold)
                trend = 'up';
            else if (slope < -threshold)
                trend = 'down';
        }
        const heapRatio = current.heapTotal > 0 ? current.heapUsed / current.heapTotal : 0;
        const spanSeconds = data.length >= 2 ? Math.round((data[data.length - 1].ts - data[0].ts) / 1000) : 0;
        // RSS linear regression over the last 20 samples → slope per minute (MB/min).
        let rssSlopePerMin = 0;
        if (tail.length >= 3) {
            const n = tail.length;
            let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
            for (let i = 0; i < n; i++) {
                sumX += i;
                sumY += tail[i].rss;
                sumXY += i * tail[i].rss;
                sumXX += i * i;
            }
            const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
            // slope = bytes per sample-index step.  Convert to MB/min.
            // Average interval between tail samples ≈ spanSeconds / (n-1).
            const avgIntervalSec = tail.length >= 2 ? spanSeconds / (tail.length - 1) : 30;
            const samplesPerMin = avgIntervalSec > 0 ? 60 / avgIntervalSec : 2;
            rssSlopePerMin = Math.round((slope * samplesPerMin / 1048576) * 100) / 100;
        }
        // GC stats over the last ~5 minutes.
        const gc = this._gcSummary(5 * 60 * 1000);
        return { current, peak, trend, sampleCount: data.length, heapRatio, spanSeconds, rssSlopePerMin, gc };
    }
    /** Aggregate GC events in the last `windowMs` milliseconds. */
    _gcSummary(windowMs) {
        if (this._gcEvents.length === 0 && this._gcMajorEvents.length === 0)
            return null;
        const cutoff = Date.now() - windowMs;
        // Major (Full) count comes from the coalesced major-GC buffer so each
        // real cycle counts once (not once per phase entry).
        const majorRecent = this._gcMajorEvents.filter(e => e.ts >= cutoff);
        const majorCount = majorRecent.length;
        // Minor count + total pause come from the general ring buffer (which holds
        // every event).  A minor cycle is a Scavenge (kind bit 1 set).
        let minorCount = 0, gcPauseMs = 0;
        for (const e of this._gcEvents) {
            if (e.ts < cutoff)
                continue;
            gcPauseMs += e.duration;
            if ((e.kind & 1) !== 0)
                minorCount++;
        }
        if (majorCount === 0 && minorCount === 0 && gcPauseMs === 0)
            return null;
        const windowMin = windowMs / 60000;
        return {
            minorCount,
            majorCount,
            majorPerMin: Math.round((majorCount / windowMin) * 100) / 100,
            gcPauseMs: Math.round(gcPauseMs * 100) / 100,
            gcPausePerMin: Math.round((gcPauseMs / windowMin) * 100) / 100,
        };
    }
    async _startGcObserver() {
        try {
            // Dynamic import — perf_hooks may not be available in all environments.
            // MUST use import(), not require(): this half is ESM, so require() throws
            // ReferenceError into the catch — silently disabling GC monitoring forever.
            const { PerformanceObserver } = await import('perf_hooks');
            this._gcObserver = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    // GC entry kinds form a bitmask (see isFullGc): 1=Scavenge(minor),
                    // 2/4/8 = MarkSweepCompact/IncrementalMarking/ProcessWeakCallbacks.
                    // A single real Full GC is usually reported as several phase entries
                    // (e.g. kind 4 + kind 8) within a few ms, so we coalesce them into
                    // one Full GC event below.
                    const kind = entry.kind ?? 0;
                    const event = { ts: Date.now(), kind, duration: entry.duration };
                    this._gcEvents.push(event);
                    // Also store full (major) GC events in a separate long-lived buffer,
                    // because they are rare and the general ring buffer may evict them.
                    if (isFullGc(kind)) {
                        const last = this._gcMajorEvents[this._gcMajorEvents.length - 1];
                        if (last && event.ts - last.ts < 500) {
                            // Same full-GC cycle (phase entries arriving back-to-back):
                            // merge into the existing event, keeping the worst-case pause.
                            last.duration = Math.max(last.duration, event.duration);
                            last.ts = event.ts;
                        }
                        else {
                            this._gcMajorEvents.push(event);
                            while (this._gcMajorEvents.length > this._gcMajorEventsCap)
                                this._gcMajorEvents.shift();
                        }
                    }
                }
                // Cap the ring buffer.
                while (this._gcEvents.length > this._gcEventsCap)
                    this._gcEvents.shift();
            });
            this._gcObserver.observe({ type: 'gc', buffered: true });
        }
        catch (_) {
            // GC observation not available — gc will remain null in summaries.
            this._gcObserver = null;
        }
    }
    _stopGcObserver() {
        if (this._gcObserver) {
            try {
                this._gcObserver.disconnect();
            }
            catch (_) { }
            this._gcObserver = null;
        }
        this._gcEvents = [];
        this._gcMajorEvents = [];
    }
    _push(s) {
        this._samples.push(s);
        if (this._samples.length > this._cap)
            this._samples.shift();
    }
}
/** Module-level singleton — one collector per process. */
let _memoryTrend = null;
// ── Private HTTP helpers ────────────────────────────────────────────────
/** Send a JSON response with no-store cache control. */
function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(payload));
}
/**
 * Read an optional JSON request body, bounded so a client cannot feed the
 * host an unbounded buffer. Returns null for an empty, oversized, or
 * unparseable body — callers treat that as "no override supplied".
 */
async function readJsonBody(req, limit = 4096) {
    try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > limit)
                return null;
            chunks.push(chunk);
        }
        if (chunks.length === 0)
            return null;
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch (_) {
        return null;
    }
}
// ── apply() ─────────────────────────────────────────────────────────────
export function apply(ctx, config) {
    // ── Settings namespace registration ──────────────────────────────────
    ctx.inject(['settings'], (settingsCtx) => {
        settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber));
    });
    // ── Memory trend collector bootstrap ──────────────────────────────────
    // One bounded ring buffer per process. Starts on first apply and stops on
    // dispose. The timer uses .unref() so it never keeps the process alive.
    if (!_memoryTrend)
        _memoryTrend = new MemoryTrendCollector();
    _memoryTrend.start((config.memPollBase?.get?.() ?? config.memPollBase) || DEFAULT_MEM_POLL_BASE, (config.memPollMin?.get?.() ?? config.memPollMin) || DEFAULT_MEM_POLL_MIN);
    ctx.effect(() => {
        const collector = _memoryTrend;
        return () => {
            collector?.stop();
            _memoryTrend = null;
        };
    });
    // ── Volatile-update handler for poll intervals ────────────────────────
    // Restart the collector when memPollBase or memPollMin change.
    ctx.on('loader/volatile-update', (paths) => {
        const memPaths = ['memPollBase', 'memPollMin'];
        if (!paths.some((pp) => pp.length && memPaths.includes(pp[pp.length - 1])))
            return;
        if (_memoryTrend) {
            _memoryTrend.stop();
            _memoryTrend.start((config.memPollBase?.get?.() ?? config.memPollBase) || DEFAULT_MEM_POLL_BASE, (config.memPollMin?.get?.() ?? config.memPollMin) || DEFAULT_MEM_POLL_MIN);
        }
    });
    // ── HTTP API route for client-side trend data ────────────────────────
    // The webServer type augmentation lives in @deepseek-ai/dsh-host-webserver
    // which is not a direct dependency; cast through `any` for the register calls.
    ctx.inject(['webServer'], (wsCtx) => {
        // GET /plugins/dsh-flash-mem-mon/memory-trend
        // Returns memory trend data for the client's config popup.
        // `mode=summary` returns a lightweight snapshot (current, peak, trend direction);
        // `mode=full` returns the raw samples for rendering a chart.
        // Optional `since` (unix ms) limits the range.
        wsCtx.effect(() => wsCtx.webServer.register({
            kind: 'exact',
            path: '/plugins/dsh-flash-mem-mon/memory-trend',
            handler: async (req, res) => {
                if (req.method !== 'GET') {
                    res.statusCode = 405;
                    res.setHeader('allow', 'GET');
                    res.end();
                    return;
                }
                if (!_memoryTrend) {
                    sendJson(res, 200, { samples: [], summary: null });
                    return;
                }
                const u = new URL(req.url || '/', 'http://localhost');
                const since = parseInt(u.searchParams.get('since') || '0', 10) || 0;
                const mode = u.searchParams.get('mode') || 'summary';
                if (mode === 'full') {
                    // For gcEvents: when no explicit `since` is requested (since=0),
                    // pass 0 so ALL stored events are returned — not just the last 5 min.
                    // gcEvents(0) → cutoff=0 → returns everything.
                    // gcEvents(undefined) → cutoff=now-5min → only recent events.
                    // The sparkline may span hours, so we need the full range.
                    const gcSince = since > 0 ? since : 0;
                    // Only return full (major) GC events to the client — minor GC is too
                    // frequent and clutters the chart.  These are already coalesced into
                    // one event per real cycle by `_startGcObserver`.  Minor GC stats are
                    // still available via mode=summary (majorPerMin, gcPausePerMin).
                    const majorGcEvents = _memoryTrend.gcEvents(gcSince);
                    sendJson(res, 200, {
                        samples: _memoryTrend.query(since || undefined),
                        gcEvents: majorGcEvents,
                    });
                }
                else {
                    sendJson(res, 200, _memoryTrend.summary(since || undefined));
                }
            },
        }), 'dsh-flash-mem-mon: GET /plugins/dsh-flash-mem-mon/memory-trend');
    });
}
