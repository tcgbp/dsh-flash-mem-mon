# Changelog — dsh-flash-mem-mon

Release-by-release history: what changed and, where it matters, why.
`git log` remains the authoritative record of individual commits — the entries
below summarise releases.

The **memory / GC monitor** companion for the core `dsh-flash` package: it
registers a host-memory-alert provider (RSS absolute thresholds, RSS growth rate,
Major GC frequency) via `ctx.get('dockFlashAlerts')` and exposes `/memory-trend`
for the trend sparklines shown in the panel.

## 0.1.6

**i18n now reuses DSH's official internationalization framework.** The client half
used to run its own locale detection: read `<html lang>`, map it to `zh`/`en`, and
keep a `MutationObserver` on that attribute so the UI followed a language switch.
`<html lang>` is not this plugin's property — the client Cordis service `locale`
(`@deepseek-ai/dsh-client-locale`) owns the active-locale preference, the dictionary
registry, the `locale/change` event and that attribute. Watching it was a side
channel: it could not see a switch that had not reached the DOM yet, and it fired
for a value nobody had chosen. The tables are now registered with the service under
the `dsh-flash-mem-mon` namespace and every read goes through it, with the eager
`ctx.get('locale')` claim paired to a `ctx.inject(['locale'])` watcher for the case
where the service is provided after this module — a transient miss never tears down
a working registration, and the fallback stays the browser language on the primary
subtag. The refresh nudge rides the `locale/change` **event**, not the service's
`subscribe()` — that is the LocaleFace render channel and fires on every revision
bump *including* dictionary registration, which happens once per plugin at boot;
`locale/change` is emitted only when the active locale actually switches, so the
imperative surfaces (Quick Control row via `quickControl.notifyChange()`, alert feed
via `alerts.notify()` — its `title`/`message` are functions precisely so they
re-read the dictionary) are nudged on a real switch, not on a registration under an
unchanged language. The open config modal rides the same event through its own
`t.onLocaleChange()` subscription. The dependency is now declared:
`@deepseek-ai/dsh-client-locale` is added to `dsh.client.inject` (load order, like
`dsh-flash` and `dsh-flash-proxy`), so the reuse is explicit rather than borrowed
through `dsh-flash`'s own inject row. There is deliberately no `t.setLocale()` here —
this plugin is a pure reader and the language row belongs to `dsh-flash`; a second
writer would be the drift this removes. Client half only; the zh/en key sets and
every call site are unchanged.

## 0.1.5

**Follows the panel core to `dsh-flash`.** First release after the core/adapter
split: the `dsh-flash` peer range is the one the combined package now demands
(`>=1.0.0-0 <2.0.0-0`), pairing with the standalone core like the other
companions. Behavior unchanged.

## 0.1.4

**Market + repository identity.** A `dsh-market` entry and the `repository` field
pointing at this repository, so the market resolves this plugin's npm name and
the card can be installed from the storefront.

## 0.1.3

**Peer range fixed.** Accept the `dock-flash` 2.x line that the combined package
published at the time, so installs against the single-package era resolve.

## 0.1.2

**Hardening pass.** A failed `apply()` is non-fatal instead of a vanished plugin;
the preference read no longer assumes `settings.describe()` returns a promise
(see Critical Rule 13 in the core's AGENTS.md); and the Gitee→GitHub mirror runs
from a workflow.

## 0.1.1

**First tagged release.** The extracted companion's initial capability set: the
RSS/GC alert provider and the `/memory-trend` endpoint. Also the trend-chart
work that made the GC story legible — Full GC detection by the non-scavenge
bitmask rather than `kind === 2`, in-window Full GC markers visible on the
sparkline and line-bidirectional-linked to the GC event list, a ±5px hit-test on
the marker click (a percentage-based hit area was too generous and caught the
wrong markers), a 0-based Y-axis shared by both the RSS and Heap lines, RSS alert
titles naming the exceeded threshold level and value, and a light-theme card
background.