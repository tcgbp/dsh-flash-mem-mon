# DSH 会话足迹现场排查报告

> 调查时间：2026-10-26 · 调查环境：`dsh-flash-mem-mon` 工作区（Web GUI / 会话 `session-ea79b745-6bbf-4fb4-864e-f2a30c49ccf3`）

## 一、本次要回答的问题

> 能不能监控到积累了多少会话，对性能有多大影响？

本报告从**现场**回答："目前 DSH 环境里到底积累了多少会话、占多少空间、对性能影响有多大"。运行时可观测性（宿主 Node 进程内存）本次无法直接测得，原因见第五节。

## 二、数据目录与会话存储定位

| 项 | 值 |
|---|---|
| DSH 数据根 `DSH_HOME` | `C:\Users\Lenin\.dsh` |
| 当前 profile | `web`（`C:\Users\Lenin\.dsh\profiles\web`） |
| 当前会话 `DSH_SESSION_ID` | `session-ea79b745-…` |
| 会话存储根 | `<DSH_HOME>\sessions` |
| 单会话文件 | `<DSH_HOME>\sessions\<工作区>\session-<UUID>\session.v4.jsonl.zstd` |

- 每个 agent 会话占一个 `session-<uuid>/` 目录。
- 会话历史以 **zstd 压缩的 JSONL**（`session.v4.jsonl.zstd`）落盘。
- 工作区按路径分隔符替换后包装在 `--…--` 目录名下（如 `--C-Users-Lenin-codes-dsh-flash-mem-mon--`）。

## 三、已积累的会话（统计快照）

**总计：10 个工作区 · 64 个会话文件 · 约 55 MB 磁盘**，全部写入于 2026-10（环境较新）。

| 工作区 | 会话数 | 总体积 | 平均每会话 |
|---|---:|---:|---:|
| dsh-flash-ctx-mon | 19 | 4.22 MB | 227 KB |
| dsh-flash | 14 | 20.88 MB | 1.53 MB |
| dsh-flash-mem-mon | 6 | 2.42 MB | 414 KB |
| scm-deck | 6 | 10.94 MB | 1.87 MB |
| dsh-flash-skin | 5 | 2.95 MB | 603 KB |
| dsh-flash-proxy | 4 | 3.65 MB | 935 KB |
| deepseek-harness-default-workspace | 4 | 4.27 MB | 1.09 MB |
| dsh-flash-net-mon | 3 | 5.02 MB | 1.71 MB |
| dock-flash | 2 | 0.29 MB | 150 KB |
| deepseek-harness | 1 | 0.13 MB | 130 KB |

单文件最大约 **7.9 MB**（dsh-flash 工作区一个超长会话）。

## 四、对性能的影响

### 4.1 磁盘层面（可直接量化）
- 会话历史共约 **55 MB**，仅占 `DSH_HOME` 总占用 **817 MB 的 ~6.7%**。
- `.dsh` 空间大头是 `skills-management`(343 MB)、`dsh-runtimes`(258 MB)、`profiles`(158 MB)——与会话数无关。
- 结论：**会话积累在磁盘层面负担极小，不是当前性能瓶颈**。

### 4.2 运行时内存层面（机制 + 局限）
- 每个**活动**会话会在宿主进程中保留对话上下文；上下文越长、并发会话越多，宿主 RSS / heap 占用越高，这是"会话数影响性能"的真正机制。
- 本插件 `dsh-flash-mem-mon` 的 host 半正是用于观测这一点：它监控宿主进程 **RSS / heapUsed 绝对值、RSS 增长斜率（线性回归 MB/min）、Major GC 频率**，并通过 `ctx.get('dockFlashAlerts')` 暴露告警。
- 若要让"会话数 → 内存影响"完全自动化，可在此基础上让 host 半追加一个会话足迹统计（见下节建议）。

## 五、本次运行时探测的局限

- 现场未发现正在运行的 `node`/`bun`/`electron`/`dsh` 进程。
- 端口 `3080` 无 `LISTEN` 监听。
- 因此在**本现场无法直接测量宿主进程的实际 RSS**（也就无法给出"每个会话占多少运行时内存"的实测值），只能通过持久化体积 + 运行时机制做评估。
- 若需要运行时实测值，需在 DSH 服务实际运行（且有宿主进程）的时刻复测。

## 六、让"监控会话积累"自动化的建议（插件扩展方向）

用户本次选择"只要现场报告，暂不动插件"。若后续要自动化，推荐的低风险增量：

1. **host 增一个只读统计路由**
   `GET /plugins/dsh-flash-mem-mon/sessions`：用 `process.env.DSH_HOME` 定位 `<DSH_HOME>\sessions`，递归统计每个工作区的会话数、zstd 文件总体积、最大会话、最新写入时间，返回 JSON。
2. **纯函数化**：把目录扫描逻辑放进 `src/pure.ts`（可单测），`index.ts` 仅做路由接线。
3. **配套单测**：`test/pure.test.ts` 覆盖空目录 / 单工作区 / 多工作区等情形。
4. （可选）client 半 `lib/client.js` 面板展示——因该文件达 ~2500 行且依赖 dock-flash 面板 API，改动风险较高，建议作为独立增量。

这样 host 侧即可以一点接入查询"各工作区积累了多少会话、多大体积"，供后续告警/面板复用。

---
*附录：`DSH_HOME` 子目录体积排行* — skills-management 343.11 MB · dsh-runtimes 258.36 MB · profiles 158.12 MB · sessions 55.19 MB · storages 1.49 MB · attachments 0.74 MB · 其余 <0.1 MB。
