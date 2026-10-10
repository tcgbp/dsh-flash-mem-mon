// Pure, dependency-free helpers extracted from index.ts so they can be unit
// tested without pulling in cordis / node HTTP / GC-entry types. Everything
// here is a pure function of its inputs.
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
export function isFullGc(kind) {
    return (kind & 1) === 0 && kind > 0;
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
export function rssSlopePerMin(samples, tailCount = 20) {
    const tail = samples.slice(-tailCount);
    if (tail.length < 3)
        return 0;
    const n = tail.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (let i = 0; i < n; i++) {
        sumX += i;
        sumY += tail[i].rss;
        sumXY += i * tail[i].rss;
        sumXX += i * i;
    }
    // slope = bytes per sample-index step.
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const tailSpanMs = Math.max(tail[tail.length - 1].ts - tail[0].ts, 0);
    if (tailSpanMs <= 0)
        return 0;
    const avgIntervalMs = tailSpanMs / (n - 1);
    const samplesPerMinute = 60000 / avgIntervalMs;
    return Math.round((slope * samplesPerMinute / 1048576) * 100) / 100;
}
