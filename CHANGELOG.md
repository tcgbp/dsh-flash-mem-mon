# Changelog — dsh-flash-mem-mon

Release-by-release history: what changed and, where it matters, why.
`git log` remains the authoritative record of individual commits — the entries
below summarise releases.

The **memory / GC monitor** companion for the core `dsh-flash` package: it
registers a host-memory-alert provider (RSS absolute thresholds, RSS growth rate,
Major GC frequency) via `ctx.get('dockFlashAlerts')` and exposes `/memory-trend`
for the trend sparklines shown in the panel.

## Unreleased

**Alert 处置按钮：立即转储堆快照。** 用上核心 `dsh-flash` 告警面板注册处置按钮的能力（告警对象上的 `actions` 数组 → 每条渲染一个按钮，`onClick(alert, api)` 执行期间按钮置灰，返回 `{message}` 保持详情面板打开）。内存/T GC 告警卡片（`host-mem-*`、`host-mem-growth`、`host-gc-*`）都挂载了同一个「立即转储堆快照」处置按钮：

- 点按后客户端 `POST /plugins/dsh-flash-mem-mon/dump-heap`；
- 宿主端 `v8.writeHeapSnapshot()` 同步写入 OS 临时目录（仅用户主动触发时才允许阻塞主线，绝不自动转储），记录最近一次快照并返回 `{name,size}`；
- 客户端借 `GET /plugins/dsh-flash-mem-mon/heap-dump` 以附件形式流式下载 `.heapsnapshot`，把保存路径回显在按钮行状态里，保持详情面板打开以便用户读取。

## 0.1.7

**Release engineering only — no runtime behaviour change.** The publish workflow is
corrected: `pnpm run --if-present build` (the flag belongs to pnpm, not the run script)
instead of the mis-ordered `pnpm run build --if-present`, pnpm pinned to `11.5.3`, and
the npm upgrade step pinned to `npm@11` for trusted publishing — no `registry-url`, so
OIDC/provenance applies on publish.

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