# dsh-flash-mem-mon

dock-flash 的内存监控提供器 — 通过 `ctx.get('dockFlashAlerts')` 注册主机内存告警提供器（RSS 绝对阈值、RSS 增长率、Major GC 频率），并暴露 `/memory-trend` 路由用于趋势图。

## 安装

```bash
dsh plugin --profile <profile> add dsh-flash-mem-mon
```

需要 `dock-flash >=1.6.0`（提供 `dockFlashAlerts` 和 `quickControl` 服务）。

## 配置

所有设置均支持热更新（volatile），修改后立即生效：

| 设置 | 默认值 | 说明 |
|---|---|---|
| `memThresholdInfo` | 256 MB | RSS 信息阈值 |
| `memThresholdWarning` | 512 MB | RSS 警告阈值 |
| `memThresholdError` | 1024 MB | RSS 错误阈值 |
| `memThresholdCritical` | 1536 MB | RSS 严重阈值 |
| `memPollBase` | 30000 ms | 基础轮询间隔 |
| `memPollMin` | 2000 ms | 最小轮询间隔 |
| `gcThresholdInfo` | 2 /min | Major GC 信息阈值 |
| `gcThresholdWarning` | 5 /min | Major GC 警告阈值 |
| `gcThresholdError` | 10 /min | Major GC 错误阈值 |

## 架构

本插件为 **伴随插件**，遵循与 `dsh-flash-net-mon` 相同的双半模式：

- **宿主端** (`src/index.ts` → tsc → `dist/index.js`)：内存趋势环形缓冲区、GC 观察器、`/memory-trend` HTTP 路由
- **客户端** (`lib/client.js`)：告警提供器、启用开关、带趋势图的配置弹窗、国际化

## 许可证

Apache-2.0
