# dsh-flash-mem-mon

Memory monitor provider for [dsh-flash](https://github.com/tcgbp/dsh-flash) — registers a host-memory-alert provider (RSS absolute thresholds, RSS growth rate, Major GC frequency) via `ctx.get('dockFlashAlerts')` and exposes `/memory-trend` for trend sparklines.

## Installation

```bash
dsh plugin --profile <profile> add dsh-flash-mem-mon
```

Requires `dsh-flash >=1.0.0` (provides `dockFlashAlerts` and `quickControl` services).

## Configuration

All settings are live-editable (volatile) and take effect immediately:

| Setting | Default | Description |
|---|---|---|
| `memThresholdInfo` | 256 MB | RSS info threshold |
| `memThresholdWarning` | 512 MB | RSS warning threshold |
| `memThresholdError` | 1024 MB | RSS error threshold |
| `memThresholdCritical` | 1536 MB | RSS critical threshold |
| `memPollBase` | 30000 ms | Base polling interval |
| `memPollMin` | 2000 ms | Minimum polling interval |
| `gcThresholdInfo` | 2 /min | Major GC info threshold |
| `gcThresholdWarning` | 5 /min | Major GC warning threshold |
| `gcThresholdError` | 10 /min | Major GC error threshold |
| `memGrowthAlertPerMin` | 1 MB/min | RSS growth-rate (linear-regression slope) alert threshold, applied with trend = up |

## Architecture

This is a **companion plugin** following the same two-half pattern as `dsh-flash-net-mon`:

- **Host half** (`src/index.ts` → tsc → `dist/index.js`): Memory trend ring buffer, GC observer, `/memory-trend` HTTP route
- **Client half** (`lib/client.js`): Alert provider, enable toggle, config modal with sparkline, i18n

## License

Apache-2.0
