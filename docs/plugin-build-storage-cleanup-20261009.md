# 2026-10-09 任务中间产物清理

已按用户要求删除本任务产生的过期桌面 App、重复资料快照、插件测试包和临时构建目录，共 62 个目录。实际可用空间从清理开始时的 0.81 GiB 增至 6.25 GiB。APFS 克隆共享块及其他进程写入会影响即时空间读数，不能将各副本的 `du` 数值直接当成实际释放量。

第一轮保留当时的 `/Applications/CrewON.app`（0.1.44）、实际用户资料和会话、0.1.14 原版 UI 对照 App、最近一次完整 App/资料恢复备份、冻结的 SDK 与正式插件发布包，以及源码、验证记录和日志。后续旧 App 清理情况见下文。未清理来源不明的目录。

当前 App 通过 `codesign --verify --deep --strict`；实际会话数据库和保留的完整恢复备份数据库均以只读方式执行 `PRAGMA quick_check`，结果为 `ok`。

逐项删除清单和验证结果保存在本工作树的 `output/extensions/cleanup-20261009/`：`cleanup.json`、`cleanup-phase2.json`、`verification.json`、`summary.json`。历史文档引用的过期 App/测试包副本可能已清理，对应源码和验证记录仍保留。

磁盘容量阻塞已解除。清理后正式桌面已更新至 0.1.45、短剧 45.0.0 已启用，见[当前交付](reelbench-replication-delivery.md)。实际 Agent 读取仍因供应商过载未通过。

## 第二轮清理

根据用户追加要求，再删除 45 个过期目录：两棵任务工作树内的 0.1.15 / 0.1.16 桌面构建、短剧 18 的旧 App 冻结副本、早期自动化测试资料快照。逐项清单为 `output/extensions/cleanup-20261009/cleanup-phase3.json`，删除前检查没有运行进程或已打开文件引用这些目录。测试日志、截图、源码、正式发布包、0.1.14 原版对照 App 和最近完整恢复备份仍保留。

第二轮实际可用空间从 6.04 GiB 增至 6.78 GiB。其他项目仍使用的 Playwright 浏览器、浏览器登录资料和 Codex 会话历史未纳入本任务中间产物清理。

## 至少 10 GiB 的目标核验

继续使用 Node 24 / pnpm 10 执行 `pnpm store prune`，清除 83 个包、3706 个缓存文件。已安装依赖、源码和用户资料保留。Python 缓存清理遇到管理员所有权文件后停止，没有提权或强制删除。

以实际文件系统可用块核验：从第一轮开始时的 0.809 GiB 增至 10.916 GiB，累计净增加 10.107 GiB。可用空间和累计净增加量均超过 10 GiB；详细读数及执行结果见 `output/extensions/cleanup-20261009/cleanup-phase4.json`。当前 App 再次通过严格签名检查。可用空间仍会随系统和其他任务的写入变化。

## 45 版安装后的旧版清理

用户明确要求删除旧版后，再删除 5 个已核验无活动引用的目录：0.1.14 原版 App、0.1.43 App 与旧资料恢复副本、42 的重复运行包、本轮 45 的 asar 展开目录和已安装包的重复 App。逐项证据为 `output/extensions/cleanup-20261009/cleanup-after-desktop45.json`。删除后即时可用空间为 18.66 GiB。

当前仅保留正式 `/Applications/CrewON.app`（0.1.45）和一份最近 0.1.44 App/SQLite 回退副本，后者位于另一任务工作树的 `output/extensions/desktop45-delivery/`。原版样式对照改为本工作树 `output/extensions/references/original-desktop-0.1.14/` 中已核验摘要的 `app.asar`、`Info.plist`，不再保留原版完整 Electron App。正式签名通过，实际资料原位保留。

10 月 9 日后续复查显示系统可用空间约 152 GiB。此增量可能包含其他清理及 APFS 延迟回收，不能归因于上述 5 个目录；本任务可直接证明的即时清理目标仍为累计净增 10.107 GiB，且后续旧包已确实删除。历史执行审批引用的插件包保留，不为节省少量空间破坏旧任务恢复。
