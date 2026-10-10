// dsh-flash-mem-mon — Memory monitor client half
// Single file, no build step. Loaded via window.__ModuleLoader__.
//
// Migrated from dock-flash/lib/client.js:
// - Memory i18n keys (zh/en)
// - createHostMemoryAlertProvider() → provider id dsh-flash-mem-mon:host-memory-alert
// - Memory enable toggle → dsh-flash-mem-mon:monitor-memory
// - MONITOR_SLIDER_FIELDS.memory (9 sliders)
// - MonitorConfigModal (memory-only branch)
// - _memPrefs preference system
//
// Route: /plugins/dsh-flash-mem-mon/memory-trend (own route)
// Cross-plugin: /plugins/dock-flash/health (read-only, for live host memory data)
//
// Provider id: dsh-flash-mem-mon:host-memory-alert
// Toggle key: dsh-flash-mem-mon:monitor-memory
// Settings namespace: dsh-flash-mem-mon
//
// ───────────────────────────────────────────────────────────────────────────
// FILE MAP — region layout (collapsible):
//   #region i18n                       (line ~33)   zh/en message tables
//   #region Preference system          (line ~280)  _MEM_ALERT_DEFAULTS, _memPrefs,
//                                                   _alertPref / loadMemPrefs,
//                                                   remote settings namespace bridge
//   #region Shared trend cache         (line ~470)  _summaryCache + _subscribeSummary
//   #region AlertProvider              (line ~510)  createHostMemoryAlertProvider:
//                                                   poll + emitIfChanged hysteresis
//   #region Icon helpers               (line ~765)  small inline SVG icons
//   #region ErrorBoundary              (line ~790)  class error boundary for modal
//   #region Styles                     (line ~840)  inline stylesheet objects
//   #region MonitorConfigModal         (line ~1170) memory-only config modal + trend
//   #region Monitor toggle helpers     (line ~2050) enable/disable toggle plumbing
//   #region Client factory             (line ~2090) inject/apply/dispose entry point
//
// DEPENDENCY/NOTE: this is deliberately a SINGLE FILE with no build step.
//   • Everything shares the `factory(require)` closure scope; no cross-file
//     verbundling. Threshold DEFAULT values mirror the HOST constants in
//     src/index.ts (change one, change both — see _MEM_ALERT_DEFAULTS).
//   • `mode=summary` polling is de-duplicated via the Shared trend cache;
//     `mode=full` (sparkline) is fetched independently by the modal.
//
// ───────────────────────────────────────────────────────────────────────────

window.__ModuleLoader__.load({
  id: 'dsh-flash-mem-mon',
  factory: (require) => {

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef
    var Component = React.Component
    var ReactDOMClient = null
    try { ReactDOMClient = require('react-dom/client') } catch (_) {}

    // ═══════════════════════════════════════════════════════════════════════
    //#region i18n ────────────────────────────────────────────────────────────

    var zh = {
      alertMemCluster: '内存监控',
      monitorOn: '已开启',
      monitorOff: '已关闭',
      monitorConfig: '配置',
      // Memory thresholds
      memConfigGroupRss: 'RSS 阈值 / 轮询',
      memConfigGroupGc: 'Major GC 阈值',
      memThresholdInfo: 'RSS 信息阈值',
      memThresholdInfoTip: 'RSS（常驻内存集）超过此值时触发信息级告警。信息级仅提示，不影响行为。建议设为正常负载的 1.5–2 倍。',
      memThresholdWarning: 'RSS 警告阈值',
      memThresholdWarningTip: 'RSS 超过此值时触发警告级告警。此时内存压力较大，应关注是否有泄漏。必须大于信息阈值。',
      memThresholdError: 'RSS 错误阈值',
      memThresholdErrorTip: 'RSS 超过此值时触发错误级告警。内存已接近危险区，建议尽快排查。必须大于警告阈值。',
      memThresholdCritical: 'RSS 严重阈值',
      memThresholdCriticalTip: 'RSS 超过此值时触发严重级告警。进程可能即将被 OOM Killer 终止，需立即处理。必须大于错误阈值。',
      memPollBase: '内存轮询基础间隔',
      memPollBaseTip: '堆使用率较低时的采样间隔（天花板）。空闲时以这个频率采样，堆越满采样越密。默认 30 秒，一般不需要调低。',
      memPollMin: '内存轮询最小间隔',
      memPollMinTip: '堆使用率很高时的采样间隔（地板）。无论堆多满，两次采样不会比这更密，避免过度消耗 CPU。默认 2 秒。',
      memGrowthThreshold: 'RSS 增长率阈值',
      memGrowthThresholdTip: 'RSS 线性回归增长率超过此值（且趋势上升）时触发“持续增长”告警。只有一个固定阈值，不区分告警级别。默认 1 MB/min。',
      // GC thresholds
      gcThresholdInfo: 'Major GC 信息阈值',
      gcThresholdInfoTip: '过去 5 分钟内 Major GC（MarkSweep/MarkCompact）频率超过此值时触发信息级告警。1/min 即每分钟一次 Full GC，正常负载下应远低于此。',
      gcThresholdWarning: 'Major GC 警告阈值',
      gcThresholdWarningTip: 'Major GC 频率超过此值时触发警告级告警。GC 已频繁到影响吞吐量，堆分配/回收振荡剧烈。必须大于信息阈值。',
      gcThresholdError: 'Major GC 错误阈值',
      gcThresholdErrorTip: 'Major GC 频率超过此值时触发错误级告警。GC 自身开销占比很高，接近或已进入泄漏状态。必须大于警告阈值。',
      // Alert preview
      alertPreviewTitle: '告警示例',
      alertPreviewToggle: '查看告警消息样例',
      alertPreviewCollapse: '收起',
      alertPreviewCriteriaRss: 'RSS 绝对值',
      alertPreviewCriteriaGrowth: 'RSS 增长率',
      alertPreviewCriteriaGc: 'Major GC 频率',
      alertPreviewTrigger: '触发',
      // Alert title (includes severity level and threshold value)
      alertHostMemInfo: 'RSS 超过信息级阈值 {threshold} MB',
      alertHostMemWarning: 'RSS 超过警告级阈值 {threshold} MB',
      alertHostMemError: 'RSS 超过错误级阈值 {threshold} MB',
      alertHostMemCritical: 'RSS 超过严重级阈值 {threshold} MB',
      alertHostMemMsg: 'RSS {v} MB | 堆 {heap}/{heapTotal} MB ({pct}%) | 外部 {ext} MB | ArrayBuffer {ab} MB | 趋势 {trend} | 增长 +{slope} MB/min{gcInfo}',
      alertHostMemGrowth: 'RSS 持续增长',
      alertHostMemGrowthMsg: '+{r} MB/min | RSS {rss} MB | 堆 {heap}/{heapTotal} MB ({pct}%) | ArrayBuffer {ab} MB | 趋势 {trend}',
      alertHostGcInfo: 'GC 频率较高',
      alertHostGcWarning: 'GC 频率异常',
      alertHostGcError: 'GC 频率极高',
      alertHostGcMsg: 'Major {v} 次/min | 暂停 {pause} ms/min | Minor {minor} 次 | RSS {rss} MB | 堆 {heap}/{heapTotal} MB ({pct}%)',
      alertSevInfo: '信息',
      alertSevWarning: '警告',
      alertSevError: '错误',
      alertSevCritical: '严重',
      // Memory live data
      memLiveData: '当前数据',
      // Host process memory
      memHostSection: 'Host 进程',
      memHostRSS: '常驻内存',
      memHostHeapTotal: '堆总大小',
      memHostHeapUsed: '堆已用',
      memHostExternal: 'C++ 外部',
      memHostArrayBuffers: 'ArrayBuffer',
      memHostHeapRatio: '堆使用率',
      memHostUnavailable: '无法获取 Host 内存数据',
      // GC stats
      memGcMajorPerMin: 'Major GC/min',
      memGcPausePerMin: 'GC 暂停/min',
      memGcMinorCount: 'Minor GC',
      memGcMajorCount: 'Major GC',
      memGcUnavailable: 'GC 监控不可用',
      memGcEventList: 'Full GC 记录',
      memGcEventDuration: '耗时',
      memGcEventTime: '时间',
      memGcEventClick: '点击定位',
      memGcNoEvents: '近期无 Full GC',
      memGcEventRssDrop: '内存释放',
      // Memory trend
      memTrend: '内存趋势',
      memTrendPeak: 'RSS 峰值',
      memTrendDirection: '趋势',
      memTrendUp: '↑ 上升',
      memTrendStable: '→ 稳定',
      memTrendDown: '↓ 下降',
      memTrendSamples: '采样数',
      memTrendSpan: '跨度',
      memTrendHeapRatio: '堆使用率',
      memTrendNoData: '暂无数据',
      memTrendHoverHeap: '堆',
      memTrendHoverRSS: 'RSS',
      memTrendHoverTime: '时间',
      memTrendGrowthRate: 'RSS 增长率',
      memTrendAxisHeap: '堆',
      memTrendAxisTime: '时间',
      memTrendInfo: '趋势信息',
    }

    var en = {
      alertMemCluster: 'Memory Monitor',
      monitorOn: 'Enabled',
      monitorOff: 'Disabled',
      monitorConfig: 'Configure',
      // Memory thresholds
      memConfigGroupRss: 'RSS / Polling',
      memConfigGroupGc: 'Major GC',
      memThresholdInfo: 'RSS Info Threshold',
      memThresholdInfoTip: 'Triggers an info-level alert when RSS (Resident Set Size) exceeds this value. Info is informational only. Recommended: 1.5–2× your normal workload RSS.',
      memThresholdWarning: 'RSS Warning Threshold',
      memThresholdWarningTip: 'Triggers a warning alert when RSS exceeds this value. Memory pressure is significant — watch for leaks. Must be greater than the Info threshold.',
      memThresholdError: 'RSS Error Threshold',
      memThresholdErrorTip: 'Triggers an error alert when RSS exceeds this value. Memory is in the danger zone — investigate promptly. Must be greater than the Warning threshold.',
      memThresholdCritical: 'RSS Critical Threshold',
      memThresholdCriticalTip: 'Triggers a critical alert when RSS exceeds this value. The process may be OOM-killed soon — act immediately. Must be greater than the Error threshold.',
      memPollBase: 'Memory Poll Base Interval',
      memPollBaseTip: 'Sampling interval when heap usage is low (the ceiling). At idle, sampling runs at this pace; as heap fills up, sampling gets denser automatically. Default 30s — rarely needs lowering.',
      memPollMin: 'Memory Poll Min Interval',
      memPollMinTip: 'Minimum sampling interval even when heap is full (the floor). Prevents excessive CPU use from too-frequent sampling. Default 2s.',
      memGrowthThreshold: 'RSS Growth Rate Threshold',
      memGrowthThresholdTip: 'Triggers the "steadily growing" alert when the RSS linear-regression slope exceeds this value (and the trend is rising). Single fixed threshold, no severity tiers. Default 1 MB/min.',
      // GC thresholds
      gcThresholdInfo: 'Major GC Info Threshold',
      gcThresholdInfoTip: 'Triggers an info alert when Major GC (MarkSweep/MarkCompact) frequency over the last 5 minutes exceeds this value. 1/min means one Full GC per minute — normal workloads should be well below this.',
      gcThresholdWarning: 'Major GC Warning Threshold',
      gcThresholdWarningTip: 'Triggers a warning when Major GC frequency exceeds this value. GC is frequent enough to hurt throughput — the heap is oscillating heavily. Must be greater than the Info threshold.',
      gcThresholdError: 'Major GC Error Threshold',
      gcThresholdErrorTip: 'Triggers an error when Major GC frequency exceeds this value. GC overhead is dominant — likely a leak. Must be greater than the Warning threshold.',
      // Alert preview
      alertPreviewTitle: 'Alert Preview',
      alertPreviewToggle: 'View alert message samples',
      alertPreviewCollapse: 'Collapse',
      alertPreviewCriteriaRss: 'RSS Absolute',
      alertPreviewCriteriaGrowth: 'RSS Growth',
      alertPreviewCriteriaGc: 'Major GC Freq',
      alertPreviewTrigger: 'trigger',
      // Alert title (includes severity level and threshold value)
      alertHostMemInfo: 'RSS exceeded info threshold {threshold} MB',
      alertHostMemWarning: 'RSS exceeded warning threshold {threshold} MB',
      alertHostMemError: 'RSS exceeded error threshold {threshold} MB',
      alertHostMemCritical: 'RSS exceeded critical threshold {threshold} MB',
      alertHostMemMsg: 'RSS {v} MB | Heap {heap}/{heapTotal} MB ({pct}%) | Ext {ext} MB | ArrayBuffer {ab} MB | Trend {trend} | Growth +{slope} MB/min{gcInfo}',
      alertHostMemGrowth: 'RSS steadily growing',
      alertHostMemGrowthMsg: '+{r} MB/min | RSS {rss} MB | Heap {heap}/{heapTotal} MB ({pct}%) | ArrayBuffer {ab} MB | Trend {trend}',
      alertHostGcInfo: 'GC frequency elevated',
      alertHostGcWarning: 'GC frequency abnormal',
      alertHostGcError: 'GC frequency critical',
      alertHostGcMsg: 'Major {v}/min | Pause {pause} ms/min | Minor {minor} | RSS {rss} MB | Heap {heap}/{heapTotal} MB ({pct}%)',
      alertSevInfo: 'Info',
      alertSevWarning: 'Warning',
      alertSevError: 'Error',
      alertSevCritical: 'Critical',
      // Memory live data
      memLiveData: 'Live Data',
      // Host process memory
      memHostSection: 'Host Process',
      memHostRSS: 'RSS',
      memHostHeapTotal: 'Heap Total',
      memHostHeapUsed: 'Heap Used',
      memHostExternal: 'C++ External',
      memHostArrayBuffers: 'ArrayBuffer',
      memHostHeapRatio: 'Heap Usage',
      memHostUnavailable: 'Host memory data unavailable',
      // GC stats
      memGcMajorPerMin: 'Major GC/min',
      memGcPausePerMin: 'GC Pause/min',
      memGcMinorCount: 'Minor GC',
      memGcMajorCount: 'Major GC',
      memGcUnavailable: 'GC monitoring unavailable',
      memGcEventList: 'Full GC Events',
      memGcEventDuration: 'Duration',
      memGcEventTime: 'Time',
      memGcEventClick: 'Click to locate',
      memGcNoEvents: 'No Full GC recently',
      memGcEventRssDrop: 'Mem Release',
      // Memory trend
      memTrend: 'Memory Trend',
      memTrendPeak: 'RSS Peak',
      memTrendDirection: 'Trend',
      memTrendUp: '↑ Rising',
      memTrendStable: '→ Stable',
      memTrendDown: '↓ Falling',
      memTrendSamples: 'Samples',
      memTrendSpan: 'Span',
      memTrendHeapRatio: 'Heap Usage',
      memTrendNoData: 'No data yet',
      memTrendHoverHeap: 'Heap',
      memTrendHoverRSS: 'RSS',
      memTrendHoverTime: 'Time',
      memTrendGrowthRate: 'RSS Growth Rate',
      memTrendAxisHeap: 'Heap',
      memTrendAxisTime: 'Time',
      memTrendInfo: 'Trend Info',
    }

    var LOCALES = { zh: zh, en: en }

    /** Read the current BCP-47 tag from <html lang> (or navigator fallback). */
    function detectLocaleTag() {
      try {
        var tag = document.documentElement.lang
        if (tag) return tag
      } catch (_) {}
      try { return navigator.language || 'en' } catch (_) { return 'en' }
    }

    /** Map a BCP-47 tag to one of our locale keys ('zh' | 'en'). */
    function resolveLocaleKey(tag) {
      var lower = (tag || '').toLowerCase()
      if (lower.startsWith('zh')) return 'zh'
      return 'en'
    }

    var _currentLocaleKey = resolveLocaleKey(detectLocaleTag())

    /** Observe <html lang> changes so the UI updates on language switch. */
    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
      try {
        var _langObserver = new MutationObserver(function () {
          var next = resolveLocaleKey(detectLocaleTag())
          if (next !== _currentLocaleKey) _currentLocaleKey = next
        })
        _langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
      } catch (_) {}
    }

    /** i18n lookup — returns the string for the current locale. */
    function t(key) {
      var locale = LOCALES[_currentLocaleKey] || LOCALES.en
      return locale[key] !== undefined ? locale[key] : (LOCALES.en[key] !== undefined ? LOCALES.en[key] : key)
    }

    /** Functional label helper — returns a function that calls t() so the label updates on locale change. */
    function L(key) {
      return function () { return t(key) }
    }

    //#endregion ───────────────────────────────────────────────────────────────

    // ═══════════════════════════════════════════════════════════════════════
    //#region Preference system ──────────────────────────────────────────────

    // NOTE: these defaults MIRROR the DEFAULT_MEM_*/DEFAULT_GC_* constants in
    // the HOST half (src/index.ts). They are only used as a last-resort fallback
    // when the remote 'dsh-flash-mem-mon' settings namespace is empty/unreadable;
    // at runtime the authoritative values come from that namespace. If you change
    // a threshold default, update src/index.ts AND this table together.
    var _MEM_ALERT_DEFAULTS = {
      memThresholdInfo: 256,
      memThresholdWarning: 512,
      memThresholdError: 1024,
      memThresholdCritical: 1536,
      memPollBase: 30000,
      memPollMin: 2000,
      gcThresholdInfo: 2,
      gcThresholdWarning: 5,
      gcThresholdError: 10,
      memGrowthAlertPerMin: 1,
    }
    var _memPrefs = Object.assign({}, _MEM_ALERT_DEFAULTS)
    var _prefCtx = null
    var MEM_MON_NS = 'dsh-flash-mem-mon'
    var _hostRevision = null
    var _prefWriteTail = Promise.resolve()
    var _pendingRevision = null

    function _fenceRevision() {
      if (_pendingRevision !== null) return _pendingRevision
      return _hostRevision === null ? undefined : _hostRevision
    }

    function _remoteSettings(ctx) {
      try {
        if (ctx && ctx.remote && ctx.remote.settings) return ctx.remote.settings
      } catch (e) {
        console.warn('[dsh-flash-mem-mon] ctx.remote.settings threw:', e && e.message)
      }
      try {
        var remote = ctx && ctx.get ? ctx.get('remote') : undefined
        if (remote && remote.settings) return remote.settings
      } catch (e) { console.warn('[dsh-flash-mem-mon] ctx.get("remote") threw:', e && e.message) }
      return undefined
    }

    /** Normalize a `describe()` result into a promise. NEVER let this throw.
     *
     *  Calling `.then` directly on a `describe()` result is not safe: the SAME
     *  method name has two implementations. The typert WIRE form returns a Promise, but the DIRECT
     *  form — `SettingsController.describe()` in
     *  `@deepseek-ai/dsh-api-settings-controller` — is SYNCHRONOUS and returns the
     *  view object itself; and it can THROW instead ("settings service is absent:
     *  mount @deepseek-ai/dsh-settings …"). So `.then` may not exist at all, and
     *  the TypeError is thrown SYNCHRONOUSLY, ahead of any `.catch`.
     *
     *  WHY THAT IS NOT JUST A LOG LINE: `apply()` here is `async` with no internal
     *  try/catch, so the throw becomes a REJECTED apply — the Cordis fiber goes
     *  FAILED and the plugin never activates. Its switches simply never appear:
     *  the "the plugin was registered and then silently disappeared" symptom,
     *  with `TypeError: settings.describe(...).then is not a function` as the
     *  only clue. Verified in dock-flash's check:overlay section 23. */
    function _describeAsync(settings) {
      try { return Promise.resolve(settings.describe()) }
      catch (err) { return Promise.reject(err) }
    }

var _PREFS_MAX_RETRIES = 8
    var _PREFS_RETRY_DELAY_MS = 750

    function loadMemPrefs(ctx, _retryCount) {
      if (typeof _retryCount !== 'number') _retryCount = 0
      var settings = _remoteSettings(ctx)
      if (!settings) return Promise.resolve(false)
      if (typeof settings.describe !== 'function') return Promise.resolve(false)
      return _describeAsync(settings).then(function (desc) {
        if (!desc) return false
        var view = desc.value || desc
        var list = view && Array.isArray(view.namespaces)
          ? view.namespaces
          : (Array.isArray(view) ? view : null)
        if (!list) return false
        var ns = list.find(function (n) {
          return (n && (n.ns || n.namespace)) === MEM_MON_NS
        })
        if (!ns) {
          if (_retryCount < _PREFS_MAX_RETRIES) {
            return new Promise(function (resolve) {
              setTimeout(function () {
                resolve(loadMemPrefs(ctx, _retryCount + 1))
              }, _PREFS_RETRY_DELAY_MS)
            })
          }
          return false
        }
        var resolved = ns.value || ns.resolved
        if (!resolved) return false
        _memPrefs = {
          memThresholdInfo: resolved.memThresholdInfo,
          memThresholdWarning: resolved.memThresholdWarning,
          memThresholdError: resolved.memThresholdError,
          memThresholdCritical: resolved.memThresholdCritical,
          memPollBase: resolved.memPollBase,
          memPollMin: resolved.memPollMin,
          gcThresholdInfo: resolved.gcThresholdInfo,
          gcThresholdWarning: resolved.gcThresholdWarning,
          gcThresholdError: resolved.gcThresholdError,
          memGrowthAlertPerMin: resolved.memGrowthAlertPerMin,
        }
        if (typeof ns.revision === 'number') _hostRevision = ns.revision
        console.log('[dsh-flash-mem-mon] preferences loaded from ' + MEM_MON_NS + ' namespace')
        return true
      }).catch(function () {
        return false
      })
    }

    /** Read an alert preference from _memPrefs, falling back to the built-in default. */
    function _alertPref(key) {
      var v = _memPrefs && _memPrefs[key]
      return (typeof v === 'number' && isFinite(v)) ? v : _MEM_ALERT_DEFAULTS[key]
    }

    /** Write an alert preference through the preference bridge (host + memory). */
    function _writeAlertPref(ctx, key, value, onError) {
      savePrefs(ctx, Object.fromEntries([[key, value]]), null, onError)
    }

    /** Save preferences: update _memPrefs in memory, then serialize a write to the 'dsh-flash-mem-mon' settings namespace. */
    function savePrefs(ctx, patch, localWrites, onError) {
      var saved = {}
      for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) saved[k] = _memPrefs && _memPrefs[k]
      if (_memPrefs) {
        for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) _memPrefs[k] = patch[k]
      }
      try { if (localWrites) localWrites() } catch (_) {}
      return _queuePrefWrite(ctx, patch, onError, saved)
    }

    function _queuePrefWrite(ctx, patch, onError, saved) {
      var task = _prefWriteTail.then(function () {
        var settings = _remoteSettings(ctx || _prefCtx)
        if (!settings || typeof settings.update !== 'function') {
          if (onError) onError(patch, function () {
            for (var k in saved) if (Object.prototype.hasOwnProperty.call(saved, k)) _memPrefs[k] = saved[k]
          })
          return false
        }
        return settings.update(MEM_MON_NS, patch, _fenceRevision())
          .then(function (res) {
            try {
              if (res && res.ok === false) {
                _pendingRevision = null
                if (onError) onError(patch, function () {
                  for (var k in saved) if (Object.prototype.hasOwnProperty.call(saved, k)) _memPrefs[k] = saved[k]
                })
                try {
                  _describeAsync(settings).then(function (desc) {
                    if (desc && desc.ok !== false) {
                      var view2 = desc.value || desc
                      var list2 = view2 && Array.isArray(view2.namespaces)
                        ? view2.namespaces
                        : (Array.isArray(view2) ? view2 : null)
                      var ns2 = list2 && list2.find(function (n) {
                        return (n && (n.ns || n.namespace)) === MEM_MON_NS
                      })
                      if (ns2 && typeof ns2.revision === 'number') _hostRevision = ns2.revision
                    }
                  }).catch(function () {})
                } catch (_) {}
                return false
              }
              var v = res && res.value
              if (v && typeof v.revision === 'number') {
                _pendingRevision = v.revision
                _hostRevision = v.revision
              }
            } catch (_) {}
            return true
          }).catch(function (err) {
            _pendingRevision = null
            if (onError) onError(patch, function () {
              for (var k in saved) if (Object.prototype.hasOwnProperty.call(saved, k)) _memPrefs[k] = saved[k]
            })
            return false
          })
      })
      _prefWriteTail = task.then(function () {}, function () {})
      return task
    }

    //#endregion ───────────────────────────────────────────────────────────────

    // ═══════════════════════════════════════════════════════════════════════
    //#region Shared trend cache ──────────────────────────────────────────────

    // The alert provider polls `?mode=summary` for alerting. The config modal
    // ALSO needs the same summary for its trend panel. Rather than both polling
    // the same route independently (which doubles the host traffic while the
    // modal is open), the provider writes each successful summary into this
    // module-level cache and notifies subscribers. The modal reads the cache on
    // mount and subscribes for live updates instead of running its own summary
    // poll. `mode=full` (sparkline raw samples + GC events) is heavier and is
    // still fetched by the modal on its own cadence — sharing that would couple
    // the modal's chart to the provider's poll, which is undesirable.
    var _summaryCache = null
    var _summaryVersion = 0
    var _summarySubscribers = []

    function _setSummaryCache(d) {
      _summaryCache = d
      _summaryVersion++
      var subs = _summarySubscribers.slice()
      _summarySubscribers.length = 0
      for (var i = 0; i < subs.length; i++) {
        try { subs[i](d, _summaryVersion) } catch (_) {}
      }
    }

    /** Subscribe to the shared summary cache. Immediately invokes `cb` with the
     *  current cache (possibly null). Returns an unsubscribe function. */
    function _subscribeSummary(cb) {
      var active = true
      try { cb(_summaryCache, _summaryVersion) } catch (_) {}
      _summarySubscribers.push(function (d, v) { if (active) { try { cb(d, v) } catch (_) {} } })
      return function () { active = false }
    }

    //#endregion ───────────────────────────────────────────────────────────────

    // ═══════════════════════════════════════════════════════════════════════
    //#region AlertProvider ──────────────────────────────────────────────────

    function createHostMemoryAlertProvider() {
      var timer = null
      var callback = null

      // Hysteresis / de-duplication: remember the last severity emitted for
      // each alert id. A candidate is pushed downstream only when its severity
      // CHANGES (first appearance, escalation, or de-escalation). Repeated
      // polls at the SAME severity are suppressed, so the same problem does not
      // re-fire every poll cycle (which would flood the alert feed).
      // Severity order: info < warning < error < critical.
      var _SEV_RANK = { info: 0, warning: 1, error: 2, critical: 3 }
      var _armed = {}
      var _seenIds = {}

      /** Push `alert` only if its severity changed since the previous poll. */
      function emitIfChanged(alerts, alert) {
        var id = alert.id
        var rank = _SEV_RANK[alert.severity] || 0
        _seenIds[id] = true
        if (_armed[id] === rank) return  // still armed at the same severity → suppress
        _armed[id] = rank
        alerts.push(alert)
      }

      /** Disarm any alert id that is no longer triggering this poll. */
      function disarmAbsent() {
        for (var id in _armed) {
          if (_armed.hasOwnProperty(id) && !_seenIds[id]) delete _armed[id]
        }
      }

      /** Called at the end of every poll cycle: disarm ids that stopped
       *  triggering. Ids still armed (and suppressed at the same severity) are
       *  kept so they continue to be suppressed on the next cycle instead of
       *  re-firing as if new. */
      function settleArmed() {
        disarmAbsent()
      }

      function poll() {
        if (!callback) return
        var alerts = []
        _seenIds = {}
        fetch('/plugins/dsh-flash-mem-mon/memory-trend?mode=summary')
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (!d || !d.current) {
              settleArmed()
              try { callback(alerts) } catch (_) {}
              return
            }

            var rssMB = Math.round(d.current.rss / 1048576)
            var heapMB = Math.round(d.current.heapUsed / 1048576)
            var heapTotalMB = Math.round(d.current.heapTotal / 1048576)
            var extMB = Math.round(d.current.external / 1048576)
            var abMB = Math.round(d.current.arrayBuffers / 1048576)
            var heapPct = d.current.heapTotal > 0 ? Math.round(d.current.heapUsed / d.current.heapTotal * 100) : 0
            var trendLabel = d.trend === 'up' ? '↑' : d.trend === 'down' ? '↓' : '→'
            var rssSlope = d.rssSlopePerMin || 0
            var slopeLabel = rssSlope.toFixed(1)
            // GC summary snippet for RSS alerts
            var gcInfoSnippet = ''
            if (d.gc && d.gc.majorPerMin > 0) {
              gcInfoSnippet = ' | GC Major ' + d.gc.majorPerMin.toFixed(1) + '/min 暂停 ' + (d.gc.gcPausePerMin || 0).toFixed(0) + 'ms/min'
            }

            // ── Criterion 1: RSS absolute value ────────────────────────
            var tInfo  = _alertPref('memThresholdInfo')
            var tWarn  = _alertPref('memThresholdWarning')
            var tErr   = _alertPref('memThresholdError')
            var tCrit  = _alertPref('memThresholdCritical')
            // Validate: info < warning < error < critical
            if (!(tInfo > 0 && tWarn > tInfo && tErr > tWarn && tCrit > tErr)) {
              tInfo = 256; tWarn = 512; tErr = 1024; tCrit = 1536
            }

            // Shared RSS alert message formatter.
            var _rssMsg = function () {
              return t('alertHostMemMsg')
                .replace('{v}', rssMB)
                .replace('{heap}', heapMB)
                .replace('{heapTotal}', heapTotalMB)
                .replace('{pct}', heapPct)
                .replace('{ext}', extMB)
                .replace('{ab}', abMB)
                .replace('{trend}', trendLabel)
                .replace('{slope}', slopeLabel)
                .replace('{gcInfo}', gcInfoSnippet)
            }

            if (rssMB >= tCrit) {
              emitIfChanged(alerts, {
                id: 'host-mem-critical',
                severity: 'critical',
                title: function () { return t('alertHostMemCritical').replace('{threshold}', tCrit) },
                message: _rssMsg,
                icon: '🔴',
                timestamp: Date.now(),
                dismissible: true,
              })
            } else if (rssMB >= tErr) {
              emitIfChanged(alerts, {
                id: 'host-mem-error',
                severity: 'error',
                title: function () { return t('alertHostMemError').replace('{threshold}', tErr) },
                message: _rssMsg,
                icon: '🟠',
                timestamp: Date.now(),
                dismissible: true,
              })
            } else if (rssMB >= tWarn) {
              emitIfChanged(alerts, {
                id: 'host-mem-warning',
                severity: 'warning',
                title: function () { return t('alertHostMemWarning').replace('{threshold}', tWarn) },
                message: _rssMsg,
                icon: '🟡',
                timestamp: Date.now(),
                dismissible: true,
              })
            } else if (rssMB >= tInfo) {
              emitIfChanged(alerts, {
                id: 'host-mem-info',
                severity: 'info',
                title: function () { return t('alertHostMemInfo').replace('{threshold}', tInfo) },
                message: _rssMsg,
                icon: '🔵',
                timestamp: Date.now(),
                dismissible: true,
              })
            }

            // ── Criterion 2: RSS growth rate ───────────────────────────
            // Threshold is configurable (memGrowthAlertPerMin); the "trend up"
            // guard is redundant with slope > 0 but kept for clarity.
            var growthThresh = _alertPref('memGrowthAlertPerMin')
            if (growthThresh > 0 && rssSlope > growthThresh && d.trend === 'up') {
              var hasRssAlert = alerts.some(function (a) {
                return a.id.indexOf('host-mem-') === 0
              })
              if (!hasRssAlert) {
                emitIfChanged(alerts, {
                  id: 'host-mem-growth',
                  severity: 'info',
                  title: function () { return t('alertHostMemGrowth') },
                  message: function () {
                    return t('alertHostMemGrowthMsg')
                      .replace('{r}', rssSlope.toFixed(1))
                      .replace('{rss}', rssMB)
                      .replace('{heap}', heapMB)
                      .replace('{heapTotal}', heapTotalMB)
                      .replace('{pct}', heapPct)
                      .replace('{ab}', abMB)
                      .replace('{trend}', trendLabel)
                  },
                  icon: '📈',
                  timestamp: Date.now(),
                  dismissible: true,
                })
              }
            }

            // ── Criterion 3: Major GC frequency ────────────────────────
            if (d.gc && d.gc.majorPerMin > 0) {
              var gcInfo  = _alertPref('gcThresholdInfo')
              var gcWarn  = _alertPref('gcThresholdWarning')
              var gcErr   = _alertPref('gcThresholdError')
              if (!(gcInfo > 0 && gcWarn > gcInfo && gcErr > gcWarn)) {
                gcInfo = 2; gcWarn = 5; gcErr = 10
              }
              var mpm = d.gc.majorPerMin
              var gcPausePerMin = d.gc.gcPausePerMin || 0
              var minorCount = d.gc.minorCount || 0

              // Shared GC alert message formatter.
              var _gcMsg = function () {
                return t('alertHostGcMsg')
                  .replace('{v}', mpm.toFixed(1))
                  .replace('{pause}', gcPausePerMin.toFixed(1))
                  .replace('{minor}', minorCount)
                  .replace('{rss}', rssMB)
                  .replace('{heap}', heapMB)
                  .replace('{heapTotal}', heapTotalMB)
                  .replace('{pct}', heapPct)
              }

              if (mpm >= gcErr) {
                emitIfChanged(alerts, {
                  id: 'host-gc-error',
                  severity: 'error',
                  title: function () { return t('alertHostGcError') },
                  message: _gcMsg,
                  icon: '🟠',
                  timestamp: Date.now(),
                  dismissible: true,
                })
              } else if (mpm >= gcWarn) {
                emitIfChanged(alerts, {
                  id: 'host-gc-warning',
                  severity: 'warning',
                  title: function () { return t('alertHostGcWarning') },
                  message: _gcMsg,
                  icon: '🟡',
                  timestamp: Date.now(),
                  dismissible: true,
                })
              } else if (mpm >= gcInfo) {
                emitIfChanged(alerts, {
                  id: 'host-gc-info',
                  severity: 'info',
                  title: function () { return t('alertHostGcInfo') },
                  message: _gcMsg,
                  icon: '🔵',
                  timestamp: Date.now(),
                  dismissible: true,
                })
              }
            }

            // Publish the summary to the shared cache so the config modal can
            // render its trend panel without issuing its own summary poll
            // (dedup of the /memory-trend?mode=summary round-trip).
            _setSummaryCache(d)

            try { settleArmed(); callback(alerts) } catch (_) {}
          })
          .catch(function () {
            settleArmed()
            try { callback([]) } catch (_) {}
          })

        // Schedule next poll
        var pollBase = _alertPref('memPollBase')
        var nextInterval = pollBase
        timer = setTimeout(poll, nextInterval)
      }

      return {
        id: 'dsh-flash-mem-mon:host-memory-alert',
        start: function (cb) {
          callback = cb
          poll()
        },
        stop: function () {
          callback = null
          if (timer) { clearTimeout(timer); timer = null }
        },
      }
    }

    //#endregion ───────────────────────────────────────────────────────────────

    // ═══════════════════════════════════════════════════════════════════════
    //#region Icon helpers ────────────────────────────────────────────────────

    var _ICON_PATHS = {
      bolt:    ['M9 2 3.5 9H8l-1 5 5.5-7H8l1-5z'],
      signal:  ['M3.2 11.6a6.8 6.8 0 0 1 9.6 0M5.6 9.2a4.2 4.2 0 0 1 4.8 0M8 6.8c.6 0 1.2.2 1.6.5M8 13a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8z'],
      shield:  ['M8 2 3 3.8v3.5c0 3.7 2.2 6.1 5 6.7 2.8-.6 5-3 5-6.7V3.8z', 'M6.2 8.1l1.2 1.2 2.4-2.6'],
    }

    function _switchIcon(icon, style) {
      var paths = typeof icon === 'string' ? _ICON_PATHS[icon] : null
      if (!paths) return h('span', { style: style }, icon)
      return h('span', { style: style, 'aria-hidden': 'true' },
        h('svg', {
          width: 12, height: 12, viewBox: '0 0 16 16',
          fill: 'none', xmlns: 'http://www.w3.org/2000/svg',
          style: { display: 'block', margin: 'auto', color: 'currentColor' },
        }, paths.map(function (d, i) {
          return h('path', { key: i, d: d, stroke: 'currentColor', strokeWidth: 1.4,
            strokeLinecap: 'round', strokeLinejoin: 'round' })
        }))
      )
    }

    //#endregion ───────────────────────────────────────────────────────────────

    // ═══════════════════════════════════════════════════════════════════════
    //#region ErrorBoundary ──────────────────────────────────────────────────

    class PanelErrorBoundary extends Component {
      constructor(props) {
        super(props)
        this.state = { hasError: false, error: null }
      }
      static getDerivedStateFromError(error) {
        return { hasError: true, error: error }
      }
      componentDidCatch(error, info) {
        console.error('[dsh-flash-mem-mon] Panel render error (caught by boundary):', error, info)
      }
      render() {
        if (this.state.hasError) {
          return h('div', {
            style: {
              padding: '12px 16px',
              color: 'var(--dsw-alias-label-secondary, #8b949e)',
              fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
              fontSize: '12px',
            },
          },
            h('div', { style: { marginBottom: '6px', color: 'var(--dsw-alias-label-warning, #d29922)' } },
              '⚠ mem-mon render error'),
            h('div', null, String(this.state.error && this.state.error.message || this.state.error || 'Unknown error')),
            h('button', {
              style: {
                marginTop: '8px',
                padding: '2px 10px',
                fontSize: '11px',
                cursor: 'pointer',
                borderRadius: '4px',
                border: '1px solid var(--dsw-alias-border-l2, #21262d)',
                background: 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.85))',
                color: 'var(--dsw-alias-label-primary, #c9d1d9)',
              },
              onClick: function () { this.setState({ hasError: false, error: null }) }.bind(this),
            }, 'Retry'),
          )
        }
        return this.props.children
      }
    }

    //#endregion ───────────────────────────────────────────────────────────────

    // ═══════════════════════════════════════════════════════════════════════
    //#region Styles ─────────────────────────────────────────────────────────

    var R = {
      xs: 'var(--dsw-radius-xs, 4px)',
      sm: 'var(--dsw-radius-sm, 8px)',
      md: 'var(--dsw-radius-md, 12px)',
      lg: 'var(--dsw-radius-lg, 16px)',
      xl: 'var(--dsw-radius-xl, 20px)',
      panel: 'var(--dsw-radius-panel, 28px)',
    }
    var E = {
      prominent: 'var(--dsw-elevation-prominent, 0 0 0 0.5px var(--dsw-alias-border-l4, #0003), 0 3px 8px 0 rgba(0,0,0,.04), 0 0 20px 0 rgba(0,0,0,.05))',
    }

    var S = {
      // Switch row / slider (used by MonitorConfigModal)
      switchRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginBottom: '8px',
      },
      switchLabel: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        minWidth: '120px',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-primary, #c9d1d9)',
      },
      switchIcon: {
        display: 'inline-flex',
        verticalAlign: '-2px',
        marginRight: '2px',
      },
      sliderRow: {
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        minWidth: 0,
        marginBottom: '8px',
      },
      slider: {
        flex: 1,
        minWidth: 0,
      },
      value: {
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary, #8b949e)',
        minWidth: '42px',
        textAlign: 'right',
      },
      // Monitor config modal
      monitorModalMask: {
        position: 'fixed',
        inset: 0,
        zIndex: 2200,
        background: 'var(--dsw-alias-bg-mask-1, #0000003d)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      },
      monitorModal: {
        background: 'var(--dsw-alias-bg-layer-2, #fff)',
        border: 0,
        borderRadius: R.panel,
        width: '90vw',
        maxWidth: '680px',
        maxHeight: '80vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: E.prominent,
      },
      monitorModalHead: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 14px',
        borderBottom: '0.5px solid var(--dsw-alias-border-l2, #0003)',
      },
      monitorModalTitle: {
        fontWeight: 500,
        fontSize: '16px',
        lineHeight: '24px',
        color: 'var(--dsw-alias-label-primary, #000)',
      },
      monitorModalClose: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '28px',
        height: '28px',
        border: 0,
        borderRadius: R.sm,
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #61666b)',
        cursor: 'pointer',
        fontSize: '14px',
        padding: 0,
      },
      monitorModalBody: {
        flex: 1,
        overflowY: 'auto',
        padding: '10px 14px',
        scrollbarWidth: 'thin',
        scrollbarColor: 'var(--dsw-alias-scrollbar-bg-l1, #ccc) var(--dsw-alias-bg-layer-2, transparent)',
      },
      monitorModalDivider: {
        marginTop: '12px',
        paddingTop: '10px',
        borderTop: '0.5px solid var(--dsw-alias-border-l2, #0003)',
      },
      monitorModalSectionTitle: {
        display: 'block',
        fontWeight: 500,
        fontSize: '14px',
        lineHeight: '22px',
        marginBottom: '8px',
        color: 'var(--dsw-alias-label-secondary, #61666b)',
      },
      monitorFieldsGrid: {
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        columnGap: '16px',
        rowGap: '12px',
      },
      monitorConfigTwoCol: {
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        columnGap: '16px',
      },
      monitorConfigGroupTitle: {
        display: 'block',
        fontWeight: 600,
        fontSize: '12px',
        marginBottom: '6px',
        color: 'var(--dsw-alias-label-secondary, #8b949e)',
      },
      // Alert preview
      alertPreviewToggle: {
        background: 'none',
        border: 0,
        padding: 0,
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-secondary, #8b949e)',
        fontSize: '12px',
      },
      alertPreviewCard: {
        padding: '8px 12px',
        background: 'var(--dsw-alias-bg-layer-1, #f5f5f5)',
        borderRadius: R.md,
        fontSize: '12px',
        lineHeight: '1.5',
      },
      alertPreviewGroup: {
        marginBottom: '8px',
      },
      alertPreviewGroupLabel: {
        display: 'block',
        fontWeight: 600,
        fontSize: '11px',
        marginBottom: '4px',
        color: 'var(--dsw-alias-label-primary, #c9d1d9)',
      },
      alertPreviewRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        marginBottom: '2px',
      },
      alertPreviewIcon: {
        flex: 'none',
        fontSize: '11px',
      },
      alertPreviewMsg: {
        flex: 1,
        color: 'var(--dsw-alias-label-secondary, #8b949e)',
      },
      alertPreviewCond: {
        color: 'var(--dsw-alias-label-secondary, #8b949e)',
        fontSize: '11px',
        opacity: 0.6,
      },
      // Memory live data
      memColumnCard: {
        padding: '8px 12px',
        background: 'var(--dsw-alias-bg-layer-1, #f5f5f5)',
        borderRadius: R.md,
      },
      memSubSectionLabel: {
        display: 'block',
        fontWeight: 600,
        fontSize: '11px',
        marginBottom: '6px',
        color: 'var(--dsw-alias-label-secondary, #8b949e)',
      },
      memLiveDataGrid: {
        display: 'grid',
        gridTemplateColumns: 'auto auto',
        columnGap: '10px',
        rowGap: '4px',
        fontSize: '12px',
      },
      memLiveDataLabel: {
        color: 'var(--dsw-alias-label-secondary, #8b949e)',
      },
      memLiveDataValue: {
        color: 'var(--dsw-alias-label-primary, #c9d1d9)',
        fontWeight: 500,
      },
      memUsageBarTrack: {
        height: '4px',
        borderRadius: '2px',
        background: 'rgba(255,255,255,0.08)',
        overflow: 'hidden',
        marginTop: '2px',
      },
      memUsageBarFill: {
        height: '100%',
        borderRadius: '2px',
        transition: 'width 0.3s ease, background 0.3s ease',
      },
      // Sparkline
      sparklineWrap: {
        position: 'relative',
        height: '80px',
        marginTop: '6px',
        marginBottom: '2px',
      },
      sparklineSvg: {
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
      },
      sparklineHover: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: '1px',
        background: 'rgba(255,255,255,0.2)',
        pointerEvents: 'none',
      },
      sparklineTooltip: {
        position: 'absolute',
        top: '-2px',
        left: '50%',
        transform: 'translateX(-50%)',
        fontSize: '10px',
        lineHeight: '14px',
        padding: '2px 6px',
        borderRadius: '4px',
        background: 'var(--dsw-alias-bg-layer-1, #f5f5f5)',
        border: '0.5px solid var(--dsw-alias-border-l4, #0003)',
        color: 'var(--dsw-alias-label-primary, #c9d1d9)',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
      },
      // Trend chart axes (HTML overlays — the SVG uses preserveAspectRatio:none
      // so SVG <text> would stretch illegibly).
      trendAxisWrap: {
        display: 'flex',
        alignItems: 'stretch',
        gap: '4px',
      },
      trendAxisY: {
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        width: '34px',
        fontSize: '9px',
        lineHeight: '10px',
        textAlign: 'right',
        color: 'var(--dsw-alias-label-secondary, #8b949e)',
        userSelect: 'none',
      },
      trendChartWrap: {
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 auto',
        minWidth: '0',
      },
      trendAxisX: {
        display: 'flex',
        justifyContent: 'space-between',
        fontSize: '9px',
        lineHeight: '12px',
        color: 'var(--dsw-alias-label-secondary, #8b949e)',
        marginTop: '2px',
        userSelect: 'none',
      },
      // GC event list
      gcEventListWrap: {
        maxHeight: '120px',
        overflowY: 'auto',
        scrollbarWidth: 'thin',
      },
      gcEventRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '2px 0',
        fontSize: '11px',
        cursor: 'pointer',
        borderRadius: '3px',
      },
      gcEventRowHighlight: {
        background: 'rgba(218, 54, 51, 0.12)',
      },
      gcEventTimeCol: {
        color: 'var(--dsw-alias-label-secondary, #8b949e)',
        minWidth: '56px',
      },
      gcEventDurationCol: {
        color: 'var(--dsw-alias-label-primary, #c9d1d9)',
        minWidth: '100px',
      },
      gcEventKindCol: {
        color: 'var(--dsw-alias-label-secondary, #8b949e)',
      },
      gcEventEmpty: {
        color: 'var(--dsw-alias-label-secondary, #8b949e)',
        fontSize: '11px',
        opacity: 0.5,
      },
    }

    //#endregion ───────────────────────────────────────────────────────────────

    // ═══════════════════════════════════════════════════════════════════════
    //#region MonitorConfigModal (memory only) ──────────────────────────────

    var MONITOR_SLIDER_FIELDS = {
      memory: [
        { key: 'memThresholdInfo',    labelKey: 'memThresholdInfo',    tooltipKey: 'memThresholdInfoTip',    group: 'rss', min: 64,    max: 1024,  step: 64,   format: function (v) { return v + ' MB' } },
        { key: 'memThresholdWarning', labelKey: 'memThresholdWarning', tooltipKey: 'memThresholdWarningTip', group: 'rss', min: 128,   max: 1536,  step: 64,   format: function (v) { return v + ' MB' } },
        { key: 'memThresholdError',   labelKey: 'memThresholdError',   tooltipKey: 'memThresholdErrorTip',   group: 'rss', min: 256,   max: 4096,  step: 64,   format: function (v) { return v + ' MB' } },
        { key: 'memThresholdCritical',labelKey: 'memThresholdCritical',tooltipKey: 'memThresholdCriticalTip',group: 'rss', min: 512,   max: 4096,  step: 64,   format: function (v) { return v + ' MB' } },
        { key: 'memPollBase',         labelKey: 'memPollBase',         tooltipKey: 'memPollBaseTip',         group: 'rss', min: 5000,  max: 60000, step: 1000, format: function (v) { return v + 'ms' } },
        { key: 'memPollMin',          labelKey: 'memPollMin',          tooltipKey: 'memPollMinTip',          group: 'rss', min: 1000,  max: 10000, step: 500,  format: function (v) { return v + 'ms' } },
        { key: 'memGrowthAlertPerMin',labelKey: 'memGrowthThreshold', tooltipKey: 'memGrowthThresholdTip', group: 'rss', min: 1,     max: 100,   step: 1,    format: function (v) { return v + ' MB/min' } },
        { key: 'gcThresholdInfo',     labelKey: 'gcThresholdInfo',     tooltipKey: 'gcThresholdInfoTip',     group: 'gc',  min: 1,     max: 5,     step: 1,    format: function (v) { return v + '/min' } },
        { key: 'gcThresholdWarning',  labelKey: 'gcThresholdWarning',  tooltipKey: 'gcThresholdWarningTip',  group: 'gc',  min: 2,     max: 8,     step: 1,    format: function (v) { return v + '/min' } },
        { key: 'gcThresholdError',    labelKey: 'gcThresholdError',    tooltipKey: 'gcThresholdErrorTip',    group: 'gc',  min: 4,     max: 15,    step: 1,    format: function (v) { return v + '/min' } },
      ],
    }

    var MONITOR_TITLE_KEY = {
      memory: 'alertMemCluster',
    }

    var _monitorConfigRoot = null
    var _monitorConfigHost = null

    function closeMonitorConfig() {
      if (_monitorConfigRoot) { try { _monitorConfigRoot.unmount() } catch (_) {} _monitorConfigRoot = null }
      if (_monitorConfigHost) { try { _monitorConfigHost.remove() } catch (_) {} _monitorConfigHost = null }
    }

    function openMonitorConfig(monitor) {
      if (!ReactDOMClient || !ReactDOMClient.createRoot) return
      closeMonitorConfig()
      var host = document.createElement('div')
      host.style.cssText = 'position:fixed;inset:0;z-index:2200;'
      document.body.appendChild(host)
      _monitorConfigHost = host
      try {
        _monitorConfigRoot = ReactDOMClient.createRoot(host)
        _monitorConfigRoot.render(h(MonitorConfigModal, {
          monitor: monitor,
          onClose: closeMonitorConfig,
        }))
      } catch (e) {
        console.error('[dsh-flash-mem-mon] failed to open monitor config:', e)
        closeMonitorConfig()
      }
    }

    function MonitorConfigModal(props) {
      var monitor = props.monitor
      var onClose = props.onClose
      var fields = MONITOR_SLIDER_FIELDS[monitor] || []
      var _tick = useState(0)
      var tick = _tick[0], setTick = _tick[1]

      // Host process memory — fetched from /health route (cross-plugin, dock-flash).
      var _hostMem = useState(null)
      var hostMem = _hostMem[0], setHostMem = _hostMem[1]

      // Memory trend summary — fetched from own /memory-trend route.
      var _trend = useState(null)
      var trendData = _trend[0], setTrendData = _trend[1]

      // Memory trend full samples — fetched on demand for sparkline.
      var _trendSamples = useState(null)
      var trendSamples = _trendSamples[0], setTrendSamples = _trendSamples[1]

      // GC events from the same full fetch — for sparkline overlay markers.
      var _gcEvents = useState(null)
      var gcEvents = _gcEvents[0], setGcEvents = _gcEvents[1]

      // Sparkline hover index (null = not hovering).
      var _hoverIdx = useState(null)
      var hoverIdx = _hoverIdx[0], setHoverIdx = _hoverIdx[1]

      // GC event highlight index (null = none selected).
      var _gcHighlightIdx = useState(null)
      var gcHighlightIdx = _gcHighlightIdx[0], setGcHighlightIdx = _gcHighlightIdx[1]

      // Close on Escape.
      useEffect(function () {
        function onKey(e) { if (e.key === 'Escape') onClose() }
        document.addEventListener('keydown', onKey)
        return function () { document.removeEventListener('keydown', onKey) }
      }, [onClose])

      // Auto-refresh host memory data every 2 seconds while the modal is open.
      useEffect(function () {
        function fetchHost() {
          fetch('/plugins/dock-flash/health').then(function (r) { return r.json() }).then(function (d) {
            if (d && d.memory) setHostMem(d.memory)
          }).catch(function () {})
        }
        fetchHost()
        var hostTimer = setInterval(fetchHost, 2000)
        return function () { clearInterval(hostTimer) }
      }, [])

      // Trend summary comes from the SHARED cache populated by the alert
      // provider's poll — subscribing (instead of issuing our own summary poll)
      // avoids double-fetching /memory-trend?mode=summary while the modal is
      // open. The provider polls roughly every memPollBase, so live updates
      // arrive at that cadence.
      useEffect(function () {
        var unsub = _subscribeSummary(function (d) {
          if (d) setTrendData(d)
        })
        // If the shared cache is empty (e.g. the alert provider is disabled or
        // has not polled yet), fetch once so the trend panel still renders.
        if (!_summaryCache) {
          fetch('/plugins/dsh-flash-mem-mon/memory-trend?mode=summary')
            .then(function (r) { return r.json() })
            .then(function (d) { if (d) _setSummaryCache(d) })
            .catch(function () {})
        }
        return function () { unsub() }
      }, [])

      // Fetch full samples for sparkline (once on mount + periodic refresh).
      useEffect(function () {
        function fetchSamples() {
          fetch('/plugins/dsh-flash-mem-mon/memory-trend?mode=full')
            .then(function (r) { return r.json() })
            .then(function (d) {
              if (d && d.samples) setTrendSamples(d.samples.slice(-360))
              if (d && d.gcEvents) setGcEvents(d.gcEvents)
            })
            .catch(function () {})
        }
        fetchSamples()
        var sampleTimer = setInterval(fetchSamples, 5000)
        return function () { clearInterval(sampleTimer) }
      }, [])

      // Render a single slider field row.
      function renderSliderField(f) {
        var val = Number(_alertPref(f.key)) || 0
        var hintEl = f.hintKey
          ? h('div', { style: { fontSize: '11px', opacity: 0.4, marginTop: '-2px' } }, t(f.hintKey))
          : null
        return h('div', { key: f.key, style: S.switchRow },
          h('span', { style: S.switchLabel },
            h('span', { style: S.switchIcon }, '⚙'),
            h('span', null, t(f.labelKey)),
            hintEl,
          ),
          h('div', { style: S.sliderRow },
            h('input', {
              type: 'range',
              min: f.min, max: f.max, step: f.step,
              value: val,
              style: S.slider,
              onChange: function (e) {
                var next = Number(e.target.value)
                _writeAlertPref(_prefCtx, f.key, next, function (patch, rollback) { rollback() })
                setTick(function (v) { return v + 1 })
              },
            }),
            h('span', { style: S.value }, f.format(val)),
          ),
        )
      }

      // For memory config: two-column layout (RSS + polling on the left, GC on the right).
      var fieldEls
      if (fields.some(function (f) { return f.group })) {
        var rssFields = fields.filter(function (f) { return f.group === 'rss' })
        var gcFields = fields.filter(function (f) { return f.group === 'gc' })
        fieldEls = h('div', { style: S.monitorConfigTwoCol },
          h('div', null,
            h('span', { style: S.monitorConfigGroupTitle }, t('memConfigGroupRss')),
            rssFields.map(renderSliderField),
          ),
          h('div', null,
            h('span', { style: S.monitorConfigGroupTitle }, t('memConfigGroupGc')),
            gcFields.map(renderSliderField),
          ),
        )
      } else {
        fieldEls = fields.map(renderSliderField)
      }

      // ── Alert preview section ──────────────────────────────────────────
      var _showPreview = useState(false)
      var showPreview = _showPreview[0], setShowPreview = _showPreview[1]

      var alertRows = []
      // ── Criterion 1: RSS absolute value ──
      var _tI = _alertPref('memThresholdInfo')
      var _tW = _alertPref('memThresholdWarning')
      var _tE = _alertPref('memThresholdError')
      var _tC = _alertPref('memThresholdCritical')
      // If user thresholds violate ordering (or are unset), fall back to the
      // canonical defaults (mirrored from host DEFAULT_MEM_*).
      if (!(_tI > 0 && _tW > _tI && _tE > _tW && _tC > _tE)) {
        _tI = _MEM_ALERT_DEFAULTS.memThresholdInfo
        _tW = _MEM_ALERT_DEFAULTS.memThresholdWarning
        _tE = _MEM_ALERT_DEFAULTS.memThresholdError
        _tC = _MEM_ALERT_DEFAULTS.memThresholdCritical
      }

      // Helper to fill all RSS alert template placeholders with sample values for preview.
      var _rssPreviewMsg = function (rssVal) {
        return t('alertHostMemMsg')
          .replace('{v}', rssVal + '')
          .replace('{heap}', '…')
          .replace('{heapTotal}', '…')
          .replace('{pct}', '…')
          .replace('{ext}', '…')
          .replace('{ab}', '…')
          .replace('{trend}', '→')
          .replace('{slope}', '0.0')
          .replace('{gcInfo}', '')
      }

      alertRows.push(
        h('div', { key: 'rss', style: S.alertPreviewGroup },
          h('span', { style: S.alertPreviewGroupLabel }, t('alertPreviewCriteriaRss')),
          h('div', { style: S.alertPreviewRow },
            h('span', { style: S.alertPreviewIcon }, '🔵'),
            h('span', { style: S.alertPreviewMsg }, t('alertHostMemInfo').replace('{threshold}', _tI)),
            h('span', { style: S.alertPreviewCond }, '≥ ' + _tI + ' MB'),
          ),
          h('div', { style: S.alertPreviewRow },
            h('span', { style: S.alertPreviewIcon }, '🟡'),
            h('span', { style: S.alertPreviewMsg }, t('alertHostMemWarning').replace('{threshold}', _tW)),
            h('span', { style: S.alertPreviewCond }, '≥ ' + _tW + ' MB'),
          ),
          h('div', { style: S.alertPreviewRow },
            h('span', { style: S.alertPreviewIcon }, '🟠'),
            h('span', { style: S.alertPreviewMsg }, t('alertHostMemError').replace('{threshold}', _tE)),
            h('span', { style: S.alertPreviewCond }, '≥ ' + _tE + ' MB'),
          ),
          h('div', { style: S.alertPreviewRow },
            h('span', { style: S.alertPreviewIcon }, '🔴'),
            h('span', { style: S.alertPreviewMsg }, t('alertHostMemCritical').replace('{threshold}', _tC)),
            h('span', { style: S.alertPreviewCond }, '≥ ' + _tC + ' MB'),
          ),
        ),
      )

      // ── Criterion 2: RSS growth rate ──
      var _growthPreviewMsg = function () {
        return t('alertHostMemGrowthMsg')
          .replace('{r}', 'N')
          .replace('{rss}', '…')
          .replace('{heap}', '…')
          .replace('{heapTotal}', '…')
          .replace('{pct}', '…')
          .replace('{ab}', '…')
          .replace('{trend}', '↑')
      }
      alertRows.push(
        h('div', { key: 'growth', style: S.alertPreviewGroup },
          h('span', { style: S.alertPreviewGroupLabel }, t('alertPreviewCriteriaGrowth')),
          h('div', { style: S.alertPreviewRow },
            h('span', { style: S.alertPreviewIcon }, '📈'),
            h('span', { style: S.alertPreviewMsg }, t('alertHostMemGrowth') + ': ' + _growthPreviewMsg()),
            h('span', { style: S.alertPreviewCond }, '> 1 MB/min + ↑'),
          ),
        ),
      )

      // ── Criterion 3: Major GC frequency ──
      var _gI = _alertPref('gcThresholdInfo')
      var _gW = _alertPref('gcThresholdWarning')
      var _gE = _alertPref('gcThresholdError')
      if (!(_gI > 0 && _gW > _gI && _gE > _gW)) { _gI = 2; _gW = 5; _gE = 10 }

      // Helper to fill all GC alert template placeholders with sample values for preview.
      var _gcPreviewMsg = function (gcVal) {
        return t('alertHostGcMsg')
          .replace('{v}', gcVal + '')
          .replace('{pause}', '…')
          .replace('{minor}', '…')
          .replace('{rss}', '…')
          .replace('{heap}', '…')
          .replace('{heapTotal}', '…')
          .replace('{pct}', '…')
      }

      alertRows.push(
        h('div', { key: 'gc', style: S.alertPreviewGroup },
          h('span', { style: S.alertPreviewGroupLabel }, t('alertPreviewCriteriaGc')),
          h('div', { style: S.alertPreviewRow },
            h('span', { style: S.alertPreviewIcon }, '🔵'),
            h('span', { style: S.alertPreviewMsg }, t('alertHostGcInfo') + ': ' + _gcPreviewMsg(_gI)),
            h('span', { style: S.alertPreviewCond }, '≥ ' + _gI + '/min'),
          ),
          h('div', { style: S.alertPreviewRow },
            h('span', { style: S.alertPreviewIcon }, '🟡'),
            h('span', { style: S.alertPreviewMsg }, t('alertHostGcWarning') + ': ' + _gcPreviewMsg(_gW)),
            h('span', { style: S.alertPreviewCond }, '≥ ' + _gW + '/min'),
          ),
          h('div', { style: S.alertPreviewRow },
            h('span', { style: S.alertPreviewIcon }, '🟠'),
            h('span', { style: S.alertPreviewMsg }, t('alertHostGcError') + ': ' + _gcPreviewMsg(_gE)),
            h('span', { style: S.alertPreviewCond }, '≥ ' + _gE + '/min'),
          ),
        ),
      )

      var alertPreviewEl = h('div', { key: 'alert-preview' },
        h('div', { style: S.monitorModalDivider }),
        h('button', {
          type: 'button',
          style: S.alertPreviewToggle,
          onClick: function () { setShowPreview(function (v) { return !v }) },
        },
          (showPreview ? '▾ ' : '▸ ') + t('alertPreviewToggle'),
        ),
        showPreview ? h('div', { style: Object.assign({}, S.alertPreviewCard, { marginTop: '6px' }) },
          alertRows,
        ) : null,
      )

      // ── Live memory data section ──────────────────────────────────────
      void hostMem   // force React to re-render when host data arrives
      void trendData // force React to re-render when trend data arrives
      void trendSamples
      void gcEvents
      void gcHighlightIdx

      var memLiveDataEl = null
      // Threshold values in MB for RSS bar colour.
      var tInfo = _alertPref('memThresholdInfo')
      var tWarn = _alertPref('memThresholdWarning')
      var tErr  = _alertPref('memThresholdError')
      var tCrit = _alertPref('memThresholdCritical')
      if (!(tInfo > 0 && tWarn > tInfo && tErr > tWarn && tCrit > tErr)) { tInfo = 256; tWarn = 512; tErr = 1024; tCrit = 1536 }
      var rssBarBaseline = Math.max(tCrit, 2048)

      // ── Host-side Node.js process ──────────────────────────────────
      var hostSectionEl = null
      if (hostMem) {
        var rssMB = (hostMem.rss / 1048576).toFixed(1)
        var rssMBNum = hostMem.rss / 1048576
        var heapTotalMB = (hostMem.heapTotal / 1048576).toFixed(1)
        var heapUsedMB = (hostMem.heapUsed / 1048576).toFixed(1)
        var externalMB = (hostMem.external / 1048576).toFixed(1)
        var arrayBufMB = (hostMem.arrayBuffers / 1048576).toFixed(1)
        var heapPct = hostMem.heapTotal > 0 ? Math.round(hostMem.heapUsed / hostMem.heapTotal * 100) : 0
        var hBarColor = 'var(--dsw-alias-brand-primary, #58a6ff)'
        if (rssMBNum >= tCrit)       hBarColor = '#f85149'
        else if (rssMBNum >= tErr)   hBarColor = '#f0883e'
        else if (rssMBNum >= tWarn)  hBarColor = '#d29922'
        else if (rssMBNum >= tInfo)  hBarColor = '#58a6ff'
        var rssBarPct = Math.min(Math.round(rssMBNum / rssBarBaseline * 100), 100)
        hostSectionEl = h('div', { style: S.memColumnCard },
          h('span', { style: S.memSubSectionLabel }, t('memHostSection')),
          h('div', { style: S.monitorConfigTwoCol },
            // ── Left: Process-level memory ──
            h('div', null,
              h('div', { style: S.memLiveDataGrid },
                h('span', { style: S.memLiveDataLabel }, t('memHostRSS')),
                h('span', { style: S.memLiveDataValue }, rssMB + ' MB'),
                h('span', { style: { gridColumn: '1 / -1' } },
                  h('div', { style: S.memUsageBarTrack },
                    h('div', {
                      style: Object.assign({}, S.memUsageBarFill, {
                        width: rssBarPct + '%',
                        background: hBarColor,
                      }),
                    })
                  )
                ),
                h('span', { style: S.memLiveDataLabel }, t('memHostExternal')),
                h('span', { style: S.memLiveDataValue }, externalMB + ' MB'),
                h('span', { style: S.memLiveDataLabel }, t('memHostArrayBuffers')),
                h('span', { style: S.memLiveDataValue }, arrayBufMB + ' MB'),
              ),
            ),
            // ── Right: Heap memory ──
            h('div', null,
              h('div', { style: S.memLiveDataGrid },
                h('span', { style: S.memLiveDataLabel }, t('memHostHeapUsed')),
                h('span', { style: S.memLiveDataValue }, heapUsedMB + ' MB'),
                h('span', { style: S.memLiveDataLabel }, t('memHostHeapTotal')),
                h('span', { style: S.memLiveDataValue }, heapTotalMB + ' MB'),
                h('span', { style: S.memLiveDataLabel }, t('memHostHeapRatio')),
                h('span', { style: S.memLiveDataValue }, heapPct + '%'),
                h('span', { style: { gridColumn: '1 / -1' } },
                  h('div', { style: S.memUsageBarTrack },
                    h('div', {
                      style: Object.assign({}, S.memUsageBarFill, {
                        width: heapPct + '%',
                        background: heapPct >= 95 ? '#f85149' : heapPct >= 85 ? '#f0883e' : heapPct >= 70 ? '#d29922' : 'var(--dsw-alias-brand-primary, #58a6ff)',
                      }),
                    })
                  )
                ),
              ),
            ),
          ),
        )
      } else {
        hostSectionEl = h('div', { style: S.memColumnCard },
          h('span', { style: S.memSubSectionLabel }, t('memHostSection')),
          h('span', { style: S.memLiveDataLabel }, t('memHostUnavailable')),
        )
      }

      // ── Memory trend section ───────────────────────────────────────
      var trendSectionEl = null
      if (trendData && trendData.current) {
        var cur = trendData.current

        // Trend direction
        var dirKey = trendData.trend === 'up' ? 'memTrendUp' : trendData.trend === 'down' ? 'memTrendDown' : 'memTrendStable'
        var dirIcon = trendData.trend === 'up' ? '↗' : trendData.trend === 'down' ? '↘' : '→'
        var dirColor = trendData.trend === 'up' ? '#f85149' : trendData.trend === 'down' ? '#3fb950' : 'var(--dsw-alias-label-secondary, #8b949e)'

        // Peak (RSS)
        var peakEl = null
        if (trendData.peak) {
          var peakMB = (trendData.peak.rss / 1048576).toFixed(1)
          peakEl = h('span', { style: S.memLiveDataValue }, peakMB + ' MB')
        } else {
          peakEl = h('span', { style: S.memLiveDataValue }, '—')
        }

        // Trend summary stats
        var trendStats = []
        trendStats.push(
          h('span', { style: S.memLiveDataLabel }, t('memTrendDirection')),
          h('span', { style: Object.assign({}, S.memLiveDataValue, { color: dirColor }) }, dirIcon + ' ' + t(dirKey)),
        )
        trendStats.push(
          h('span', { style: S.memLiveDataLabel }, t('memTrendPeak')),
          peakEl,
        )
        if (trendData.sampleCount) {
          trendStats.push(
            h('span', { style: S.memLiveDataLabel }, t('memTrendSamples')),
            h('span', { style: S.memLiveDataValue }, '' + trendData.sampleCount),
          )
        }
        if (trendData.spanMs) {
          var spanMin = Math.round(trendData.spanMs / 60000)
          trendStats.push(
            h('span', { style: S.memLiveDataLabel }, t('memTrendSpan')),
            h('span', { style: S.memLiveDataValue }, spanMin + ' min'),
          )
        }
        if (typeof cur.heapRatio === 'number') {
          trendStats.push(
            h('span', { style: S.memLiveDataLabel }, t('memTrendHeapRatio')),
            h('span', { style: S.memLiveDataValue }, (cur.heapRatio * 100).toFixed(0) + '%'),
          )
        }
        if (trendData.rssSlopePerMin) {
          trendStats.push(
            h('span', { style: S.memLiveDataLabel }, t('memTrendGrowthRate')),
            h('span', { style: S.memLiveDataValue }, (trendData.rssSlopePerMin > 0 ? '+' : '') + trendData.rssSlopePerMin.toFixed(2) + ' MB/min'),
          )
        }

        // GC summary
        if (trendData.gc) {
          trendStats.push(
            h('span', { style: S.memLiveDataLabel }, t('memGcMajorPerMin')),
            h('span', { style: S.memLiveDataValue }, trendData.gc.majorPerMin.toFixed(2)),
          )
          trendStats.push(
            h('span', { style: S.memLiveDataLabel }, t('memGcMinorCount')),
            h('span', { style: S.memLiveDataValue }, '' + trendData.gc.minorCount),
          )
          trendStats.push(
            h('span', { style: S.memLiveDataLabel }, t('memGcMajorCount')),
            h('span', { style: S.memLiveDataValue }, '' + trendData.gc.majorCount),
          )
        }

        // Sparkline
        var sparklineEl = null
        if (trendSamples && trendSamples.length > 1) {
          var svgW = 280
          var svgH = 80
          var padY = 4
          var rssValues = trendSamples.map(function (s) { return s.rss })
          var maxRss = Math.max.apply(null, rssValues)
          // Shared Y-axis: min fixed at 0, max = RSS peak — both lines on the same absolute scale.
          var yAxisMax = maxRss
          var yAxisRange = yAxisMax || 1
          var xStep = svgW / (trendSamples.length - 1)

          // Build polyline points for RSS (0-based scale)
          var points = []
          for (var i = 0; i < trendSamples.length; i++) {
            var x = i * xStep
            var y = svgH - padY - (rssValues[i] / yAxisRange) * (svgH - 2 * padY)
            points.push(x.toFixed(1) + ',' + y.toFixed(1))
          }

          // Heap line (same 0-based scale)
          var heapPoints = null
          var heapValues = trendSamples.map(function (s) { return s.heapUsed })
          if (Math.max.apply(null, heapValues) > 0) {
            heapPoints = []
            for (var i = 0; i < trendSamples.length; i++) {
              var x = i * xStep
              var y = svgH - padY - (heapValues[i] / yAxisRange) * (svgH - 2 * padY)
              heapPoints.push(x.toFixed(1) + ',' + y.toFixed(1))
            }
          }

          // GC event markers
          // Only Full GC events (non-scavenge, i.e. kind bit 1 unset) are drawn
          // on the trend chart, scoped to the same visible window as
          // `trendSamples` (majors outside [tsFirst, tsLast] are skipped so they
          // don't map off-viewBox), and the x is clamped so an in-window Full GC
          // is always drawn.  Each marker's identity is its original index in the
          // `gcEvents` payload so clicking a Full GC row in the list (which sets
          // `gcHighlightIdx` to that same index) can make its marker stand out.
          var gcMarkers = null
          var gcMarkerPositions = []  // [{geIdx, rx, ts}] for click hit-testing in overlay
          if (gcEvents && gcEvents.length > 0) {
            var tsFirst = trendSamples[0].ts
            var tsLast = trendSamples[trendSamples.length - 1].ts
            var tsRange = tsLast - tsFirst || 1
            gcMarkers = gcEvents.map(function (ge, geIdx) {
              if ((ge.kind & 1) !== 0) return null              // not a Full GC
              if (ge.ts < tsFirst || ge.ts > tsLast) return null // outside window
              var x = Math.max(0, Math.min(((ge.ts - tsFirst) / tsRange) * svgW, svgW))
              var baseWidth = Math.max(1.5, svgW / (trendSamples.length - 1) / 4)
              // Store position for overlay click hit-testing.
              gcMarkerPositions.push({ geIdx: geIdx, rx: x / svgW, ts: ge.ts })
              // Selected (or none selected) → prominent; otherwise dimmed so the
              // current Full GC visually pops against the rest.
              var isSel = gcHighlightIdx === geIdx
              var width = isSel ? baseWidth * 1.4 : baseWidth * 0.6
              return h('g', { key: 'gc-' + geIdx },
                h('rect', {
                  x: x - width / 2, y: 0, width: width, height: svgH,
                  fill: isSel ? 'rgba(218, 54, 51, 0.25)' : 'rgba(240, 136, 62, 0.07)',
                }),
                h('line', {
                  x1: x, y1: 0, x2: x, y2: svgH,
                  stroke: isSel ? '#da3633' : 'rgba(240, 136, 62, 0.30)',
                  strokeWidth: isSel ? 1.5 : 1,
                }),
              )
            })
          }

          // Hover line + tooltip
          var hoverLineEl = null
          var hoverTooltipEl = null
          if (hoverIdx !== null && hoverIdx >= 0 && hoverIdx < trendSamples.length) {
            var hx = hoverIdx * xStep
            hoverLineEl = h('line', {
              x1: hx, y1: 0, x2: hx, y2: svgH,
              stroke: 'rgba(255,255,255,0.2)', strokeWidth: 1,
            })
            var hSample = trendSamples[hoverIdx]
            var hRssMB = (hSample.rss / 1048576).toFixed(1)
            var hHeapMB = hSample.heapUsed ? (hSample.heapUsed / 1048576).toFixed(1) : null
            var hTime = new Date(hSample.ts)
            var hTimeStr = hTime.getHours().toString().padStart(2, '0') + ':' +
                           hTime.getMinutes().toString().padStart(2, '0') + ':' +
                           hTime.getSeconds().toString().padStart(2, '0')
            hoverTooltipEl = h('div', {
              style: Object.assign({}, S.sparklineTooltip, {
                left: Math.min(hx, svgW - 80) + 'px',
              }),
            },
              t('memTrendHoverRSS') + ': ' + hRssMB + ' MB',
              hHeapMB ? '  ' + t('memTrendHoverHeap') + ': ' + hHeapMB + ' MB' : '',
              '  ' + t('memTrendHoverTime') + ': ' + hTimeStr,
            )
          }

          // ---- Coordinate axes (HTML overlays; the SVG viewBox uses
          // preserveAspectRatio:none so SVG <text> would stretch illegibly) ----
          var _fmtHM = function (ts) {
            var d = new Date(ts)
            return d.getHours().toString().padStart(2, '0') + ':' +
                   d.getMinutes().toString().padStart(2, '0')
          }
          var _fmtMB = function (v) { return Math.round(v / 1048576) }

          // X axis: first / middle / last sample times (HH:MM).
          var tMid = trendSamples[Math.floor((trendSamples.length - 1) / 2)].ts
          var tLast = trendSamples[trendSamples.length - 1].ts
          var xAxisEl = h('div', { style: S.trendAxisX },
            h('span', null, _fmtHM(trendSamples[0].ts)),
            h('span', null, _fmtHM(tMid)),
            h('span', null, _fmtHM(tLast)),
          )

          // Y axis: 0 / mid / max (0-based scale, both lines share it).
          var yAxisEl = h('div', {
            style: Object.assign({}, S.trendAxisY, { height: svgH + 'px' }),
          },
            h('span', null, _fmtMB(yAxisMax) + 'M'),
            h('span', null, _fmtMB(yAxisMax / 2) + 'M'),
            h('span', null, '0'),
          )

          sparklineEl = h('div', { style: S.trendAxisWrap },
            yAxisEl,
            h('div', { style: S.trendChartWrap },
              h('div', { style: S.sparklineWrap },
                h('svg', {
                  viewBox: '0 0 ' + svgW + ' ' + svgH,
                  preserveAspectRatio: 'none',
                  style: S.sparklineSvg,
                },
                  heapPoints ? h('polyline', {
                    points: heapPoints.join(' '),
                    fill: 'none',
                    stroke: 'rgba(88, 166, 255, 0.3)',
                    strokeWidth: 1,
                  }) : null,
                  h('polyline', {
                    points: points.join(' '),
                    fill: 'none',
                    stroke: '#3fb950',
                    strokeWidth: 1.2,
                  }),
                  gcMarkers,
                  hoverLineEl,
                ),
                hoverTooltipEl,
                // Mouse interaction overlay
                h('div', {
                  style: { position: 'absolute', inset: 0, cursor: 'crosshair' },
                  onMouseMove: function (e) {
                    var rect = e.currentTarget.getBoundingClientRect()
                    var rx = (e.clientX - rect.left) / rect.width
                    var idx = Math.round(rx * (trendSamples.length - 1))
                    setHoverIdx(Math.max(0, Math.min(idx, trendSamples.length - 1)))
                    // Switch cursor to pointer when hovering near a GC marker.
                    var nearGc = false
                    var mousePx = e.clientX - rect.left
                    for (var gi = 0; gi < gcMarkerPositions.length; gi++) {
                      if (Math.abs(gcMarkerPositions[gi].rx * rect.width - mousePx) <= 5) {
                        nearGc = true
                        break
                      }
                    }
                    e.currentTarget.style.cursor = nearGc ? 'pointer' : 'crosshair'
                  },
                  onMouseLeave: function (e) {
                    setHoverIdx(null)
                    e.currentTarget.style.cursor = 'crosshair'
                  },
                  onClick: function (e) {
                    // Check if click is near a Full GC marker.
                    // Use pixel distance: only match if within ±5px of a marker.
                    var rect = e.currentTarget.getBoundingClientRect()
                    var clickPx = e.clientX - rect.left
                    var pxPerUnit = rect.width / svgW
                    var hitPx = 5
                    var hitGc = null
                    var hitDist = Infinity
                    for (var gi = 0; gi < gcMarkerPositions.length; gi++) {
                      var markerPx = gcMarkerPositions[gi].rx * rect.width
                      var d = Math.abs(clickPx - markerPx)
                      if (d <= hitPx && d < hitDist) {
                        hitGc = gcMarkerPositions[gi]
                        hitDist = d
                      }
                    }
                    if (hitGc) {
                      // Toggle: clicking the same marker again deselects.
                      setGcHighlightIdx(gcHighlightIdx === hitGc.geIdx ? null : hitGc.geIdx)
                      // Move hover to the nearest sample.
                      var bestIdx = 0
                      var bestDist2 = Math.abs(trendSamples[0].ts - hitGc.ts)
                      for (var si2 = 1; si2 < trendSamples.length; si2++) {
                        var dist2 = Math.abs(trendSamples[si2].ts - hitGc.ts)
                        if (dist2 < bestDist2) { bestDist2 = dist2; bestIdx = si2 }
                      }
                      setHoverIdx(bestIdx)
                    } else {
                      // Clicked empty area → clear GC highlight.
                      setGcHighlightIdx(null)
                    }
                  },
                }),
              ),
              xAxisEl,
            ),
          )
        }

        // GC event list
        var gcEventListEl = (function () {
          if (!trendSamples || trendSamples.length === 0) {
            return h('div', null,
              h('span', { style: S.monitorConfigGroupTitle }, t('memGcEventList')),
              h('div', { style: S.gcEventEmpty }, t('memGcNoEvents')),
            )
          }
          var _dropThresh = 10 * 1048576  // 10 MB
          var dropEvents = []
          // A) RSS drops from samples
          for (var si = 1; si < trendSamples.length; si++) {
            var rssDrop = trendSamples[si - 1].rss - trendSamples[si].rss
            if (rssDrop >= _dropThresh) {
              dropEvents.push({
                idx: dropEvents.length,
                ts: trendSamples[si].ts,
                rssDropMB: (rssDrop / 1048576).toFixed(1),
                source: 'sample',
                sampleIdx: si,
              })
            }
          }
          // B) gcEvents (kind=2, already filtered server-side)
          if (gcEvents && gcEvents.length > 0) {
            var tsFirst = trendSamples[0].ts
            var tsLast = trendSamples[trendSamples.length - 1].ts
            for (var ei = 0; ei < gcEvents.length; ei++) {
              var ge = gcEvents[ei]
              if (ge.ts < tsFirst || ge.ts > tsLast) continue
              // Try to find the RSS drop around this GC event from samples.
              var rssDropMB = null
              // First: check if it merges with an existing sample-sourced RSS drop event (within 5s).
              var duped = false
              for (var di = 0; di < dropEvents.length; di++) {
                if (dropEvents[di].source === 'sample' && Math.abs(dropEvents[di].ts - ge.ts) < 5000) {
                  rssDropMB = dropEvents[di].rssDropMB
                  dropEvents[di].source = 'gc'
                  dropEvents[di].duration = ge.duration
                  dropEvents[di].gcIdx = ei
                  duped = true
                  break
                }
              }
              // Second: if no existing RSS drop matched, scan nearby samples for a drop.
              if (!duped) {
                for (var si2 = 1; si2 < trendSamples.length; si2++) {
                  var timeDiff = Math.abs(trendSamples[si2].ts - ge.ts)
                  if (timeDiff > 10000) continue  // only look within ±10s
                  var nearDrop = trendSamples[si2 - 1].rss - trendSamples[si2].rss
                  if (nearDrop > 0) {
                    rssDropMB = (nearDrop / 1048576).toFixed(1)
                    break
                  }
                }
                dropEvents.push({
                  idx: dropEvents.length,
                  ts: ge.ts,
                  rssDropMB: rssDropMB,
                  source: 'gc',
                  gcIdx: ei,
                  duration: ge.duration,
                })
              }
            }
          }
          if (dropEvents.length === 0 && (!trendData.gc || trendData.gc.majorCount === 0)) {
            return h('div', null,
              h('span', { style: S.monitorConfigGroupTitle }, t('memGcEventList')),
              h('div', { style: S.gcEventEmpty }, t('memGcNoEvents')),
            )
          }
          var listContent = null
          if (dropEvents.length > 0) {
            listContent = h('div', { style: S.gcEventListWrap },
              dropEvents.map(function (item) {
                var evIdx = item.idx
                var evTs = item.ts
                var evTime = new Date(evTs)
                var evTimeStr = evTime.getHours().toString().padStart(2, '0') + ':' +
                                evTime.getMinutes().toString().padStart(2, '0') + ':' +
                                evTime.getSeconds().toString().padStart(2, '0')
                var isGcSource = item.source === 'gc'
                // Highlight identity must match the chart marker key, which is
                // the original index in the `gcEvents` payload.  GC-sourced rows
                // carry that index in `item.gcIdx`; RSS-drop rows have no chart
                // marker, so fall back to the row index.
                var evKey = isGcSource ? item.gcIdx : evIdx
                var isHighlighted = gcHighlightIdx === evKey
                // Build detail string: show both duration and memory released when available.
                var detailParts = []
                if (isGcSource && item.duration) {
                  detailParts.push(item.duration.toFixed(1) + ' ms')
                }
                if (item.rssDropMB && item.rssDropMB !== '—') {
                  detailParts.push('-' + item.rssDropMB + ' MB')
                }
                var detailStr = detailParts.length > 0 ? detailParts.join(' | ') : '—'
                var kindStr = isGcSource ? 'Full GC' : t('memGcEventRssDrop')
                return h('div', {
                  key: 'gc-ev-' + evIdx,
                  ref: isHighlighted ? function (el) {
                    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
                  } : undefined,
                  style: Object.assign({}, S.gcEventRow, isHighlighted ? S.gcEventRowHighlight : {}),
                  onClick: function () {
                    if (!trendSamples || trendSamples.length === 0) return
                    var bestIdx = 0
                    var bestDist = Math.abs(trendSamples[0].ts - evTs)
                    for (var si2 = 1; si2 < trendSamples.length; si2++) {
                      var dist = Math.abs(trendSamples[si2].ts - evTs)
                      if (dist < bestDist) { bestDist = dist; bestIdx = si2 }
                    }
                    setHoverIdx(bestIdx)
                    setGcHighlightIdx(evKey)
                  },
                  onMouseEnter: function (e) {
                    e.currentTarget.style.background = 'rgba(218, 54, 51, 0.18)'
                  },
                  onMouseLeave: function (e) {
                    e.currentTarget.style.background = isHighlighted ? 'rgba(218, 54, 51, 0.12)' : ''
                  },
                },
                  h('span', { style: S.gcEventTimeCol }, evTimeStr),
                  h('span', { style: S.gcEventDurationCol }, detailStr),
                  h('span', { style: S.gcEventKindCol }, kindStr),
                )
              })
            )
          } else {
            listContent = h('div', { style: S.gcEventEmpty }, t('memGcNoEvents'))
          }
          return h('div', null,
            h('span', { style: S.monitorConfigGroupTitle }, t('memGcEventList')),
            listContent,
          )
        })()

        trendSectionEl = h('div', { style: S.memColumnCard },
          h('span', { style: S.memSubSectionLabel }, t('memTrend')),
          // Trend chart on top.
          sparklineEl,
          // Below: two columns — trend info on the left, Full GC list on the right.
          h('div', { style: Object.assign({}, S.monitorConfigTwoCol, { marginTop: '8px' }) },
            h('div', null,
              h('span', { style: S.monitorConfigGroupTitle }, t('memTrendInfo')),
              h('div', { style: S.memLiveDataGrid }, trendStats),
            ),
            gcEventListEl,
          ),
        )
      } else {
        trendSectionEl = h('div', { style: S.memColumnCard },
          h('span', { style: S.memSubSectionLabel }, t('memTrend')),
          h('span', { style: S.memLiveDataLabel }, t('memTrendNoData')),
        )
      }

      memLiveDataEl = h('div', { key: 'live-data' },
        h('div', { style: S.monitorModalDivider }),
        h('span', { style: S.monitorModalSectionTitle }, t('memLiveData')),
        hostSectionEl,
        trendSectionEl,
      )

      return h('div', {
        style: S.monitorModalMask,
        onMouseDown: function (e) { if (e.target === e.currentTarget) onClose() },
      },
        h('div', { style: S.monitorModal },
          h('div', { style: S.monitorModalHead },
            h('span', { style: S.monitorModalTitle },
              t(MONITOR_TITLE_KEY[monitor] || 'alertMemCluster') + ' — ' + t('monitorConfig')),
            h('button', {
              type: 'button',
              'data-dock-flash-focus': '',
              style: S.monitorModalClose,
              onClick: onClose,
            }, '✕'),
          ),
          h('div', { style: S.monitorModalBody },
            fieldEls,
            alertPreviewEl,
            memLiveDataEl,
          ),
        ),
      )
    }

    //#endregion ───────────────────────────────────────────────────────────────

    // ═══════════════════════════════════════════════════════════════════════
    //#region Monitor toggle helpers ──────────────────────────────────────────

    /** Check whether dock-flash's system-alerts master toggle is ON. */
    function _getAlertsOn() {
      try { return localStorage.getItem('dock-flash:system-alerts') !== '0' } catch (_) { return true }
    }

    var TOGGLE_KEY = 'dsh-flash-mem-mon:monitor-memory'
    var PROVIDER_ID = 'dsh-flash-mem-mon:host-memory-alert'

    var _MONITOR_TOGGLES = {
      memory: {
        key: TOGGLE_KEY,
        providers: [PROVIDER_ID],
      },
    }
    var _MONITOR_DEFAULT = { memory: true }

    function _getMonitorOn(monitor) {
      var def = _MONITOR_DEFAULT[monitor] !== false
      try { return localStorage.getItem(_MONITOR_TOGGLES[monitor].key) !== '0' } catch (_) { return def }
    }

    function _setMonitorOn(monitor, on, alertRegistry) {
      var providers = _MONITOR_TOGGLES[monitor].providers
      for (var i = 0; i < providers.length; i++) {
        try { alertRegistry.setProviderEnabled(providers[i], on) } catch (_) {}
      }
      try { localStorage.setItem(_MONITOR_TOGGLES[monitor].key, on ? '1' : '0') } catch (_) {}
    }

    function _monitorSubtitle(m) {
      return function () {
        return _getMonitorOn(m) ? t('monitorOn') : t('monitorOff')
      }
    }

    //#endregion ───────────────────────────────────────────────────────────────

    // ═══════════════════════════════════════════════════════════════════════
    //#region Client factory ─────────────────────────────────────────────────

    var client = {
      inject: ['remote', 'remote.settings'],
      async apply(ctx) {
        // A throw anywhere inside the real apply used to REJECT this async
        // apply — and a failed apply FAILS the plugin's Cordis fiber, so the
        // plugin never activates and its switch silently never appears. That
        // is not hypothetical: a `settings.describe().then(...)` TypeError did
        // exactly this. Registration failures are REPORTED here, never fatal.
        try {
          await client._applyInner(ctx)
        } catch (err) {
          console.error('[dsh-flash-mem-mon] apply failed (non-fatal):', err)
        }
      },

      async _applyInner(ctx) {
        _prefCtx = ctx

        // 1. Load mem-mon preferences from the 'dsh-flash-mem-mon' settings namespace
        loadMemPrefs(ctx).then(function (ok) {
          // Sync alert providers with the localStorage-backed state.
          var lsOn
          try { lsOn = localStorage.getItem(TOGGLE_KEY) !== '0' } catch (_) { lsOn = true }
          try {
            var reg = ctx.get && ctx.get('quickControl')
            if (reg && typeof reg.notifyChange === 'function') {
              reg.notifyChange(TOGGLE_KEY)
            }
          } catch (_) {}
          var alertReg = ctx.get && ctx.get('dockFlashAlerts')
          if (alertReg) {
            try { alertReg.setProviderEnabled(PROVIDER_ID, lsOn) } catch (_) {}
          }
        })

        // 2. Register with dock-flash's quickControl and dockFlashAlerts services.
        var _registered = false

        function _registerServices(registry, alertRegistry) {
          if (_registered) return
          if (!registry || !alertRegistry) {
            console.warn('[dsh-flash-mem-mon] _registerServices: missing service — quickControl=' + !!registry + ', alerts=' + !!alertRegistry)
            return
          }
          _registered = true
          console.log('[dsh-flash-mem-mon] registering provider and switch')

          // 3. Register memory alert provider
          var memProvider = createHostMemoryAlertProvider()
          alertRegistry.registerProvider(memProvider)

          // 4. Register memory monitor toggle switch
          ctx.effect(function () {
            var dispose = registry.registerSwitch({
              id: TOGGLE_KEY,
              label: L('alertMemCluster'),
              icon: 'chip',
              type: 'toggle',
              group: 'system',
              cluster: 'system-alerts',
              order: 58,
              visible: function () {
                return _getAlertsOn()
              },
              config: function () { openMonitorConfig('memory') },
              getValue: function () { return _getMonitorOn('memory') },
              setValue: function (v) {
                _setMonitorOn('memory', v, alertRegistry)
                registry.notifyChange(TOGGLE_KEY)
                try { alertRegistry.notify() } catch (_) {}
              },
            })
            return dispose
          }, 'dsh-flash-mem-mon: monitor-memory switch')

          // 5. Apply persisted toggle gates — before the alert registry auto-starts
          Object.keys(_MONITOR_TOGGLES).forEach(function (m) {
            if (!_getMonitorOn(m)) _setMonitorOn(m, false, alertRegistry)
          })
        }

        // Passive: listen for dock-flash:ready event
        try {
          ctx.on('dock-flash:ready', function (payload) {
            console.log('[dsh-flash-mem-mon] dock-flash:ready event received — quickControl=' + !!(payload && payload.quickControl) + ', alerts=' + !!(payload && payload.alerts))
            _registerServices(payload.quickControl, payload.alerts)
          })
        } catch (e) {
          console.warn('[dsh-flash-mem-mon] ctx.on("dock-flash:ready") failed:', e)
        }

        // Active: check if dock-flash already loaded
        var registry = ctx.get('quickControl')
        var alertRegistry = ctx.get('dockFlashAlerts')
        console.log('[dsh-flash-mem-mon] active check — quickControl=' + !!registry + ', alerts=' + !!alertRegistry)
        if (registry && alertRegistry) _registerServices(registry, alertRegistry)

        // Fallback: poll briefly
        if (!_registered) {
          var _retryCount = 0
          function _retryGet() {
            if (_registered) return
            var r = ctx.get('quickControl')
            var a = ctx.get('dockFlashAlerts')
            if (r && a) { _registerServices(r, a); return }
            if (++_retryCount < 15) setTimeout(_retryGet, 200)
          }
          setTimeout(_retryGet, 0)
        }
      },

      dispose() {
        closeMonitorConfig()
      },
    }
    return client
    //#endregion ───────────────────────────────────────────────────────────────
  },
})
