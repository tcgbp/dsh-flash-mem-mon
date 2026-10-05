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
var client = {
  apply: function (ctx) {
    // Task 3: register memory alert provider, enable toggle,
    // config modal, i18n, slider definitions
  },
  dispose: function () {},
}
var _exports = null
try {
  _exports = (globalThis.__ModuleLoader__ || {}).load
    ? globalThis.__ModuleLoader__.load({ id: 'dsh-flash-mem-mon/client', factory: function () { return client } })
    : client
} catch (_) { _exports = client }
export default _exports
