# 原宿主工作空间的插件项目分配

2026-10-11：Native 分配模块与实际文件系统专项已实现。尚未接入 Control namespace 写事务、中央 Agent provisioning 或产品项目入口；这里的 `registered` 只表示 Native 目录和原 registry 已观察一致，不代表完整项目可执行。

## 接口与范围

`LocalWorkspaceProjectAllocator(actualAuthority, trustedOwner)` 捕获原 `LocalWorkspaceAuthority` 的真实实例和 Domain 严格解析的完整 owner。owner 使用已有 `tenantId`、`spaceId`、`principalId`、`actorId`、`profileId`、`pluginId`、`publisherId`、`projectId`；版本、digest 和临时授权不参与空间 identity。Host 对这个 owner 的权限仍需在实际接线时沿用原鉴权，不可直接接受 renderer 指定 owner。

实例提供无参数的 `inspect()`、`provision()`、`recover()`。工作空间 ID 由完整 owner 稳定派生，目录只能生成在实际宿主 dataDirectory 内。接口没有调用者指定的路径、cwd 或 workspaceId，也没有新增 renderer IPC/SDK 命令。没有第二套 Workspace 执行系统；文件和会话仍使用原宿主能力。

分配向原 `desktop-workspace.json` v2 追加原 `{workspaceId, root}`，不更改其 JSON shape，不切换活动工作空间。新 registration proof 只在 Native 内部存在、绑定同一个 authority 实例且只能消费一次。复制、反序列化或其他真实 authority 均不能借用。原活动文件读取的私有 binding generation 保持不变，原 select/activate/clear 仍使旧读取失效。

## 持久阶段与失败恢复

新增私有 `desktop-plugin-project-workspaces.json` 保存 Native 分配 intent：schema、revision 和最多 100 个完整 owner 的 allocation；总大小上限 128 KiB，文件为 0600。阶段只有 `pending`、`registered`、`failed`，不含 SQL committed、目录路径、任务权限或产品 ready。查询返回不透明 workspaceId、持久阶段、实际观察和有界失败代码，不暴露 owner 或路径。

操作顺序为：持久 pending → 在受控 0700 staging 目录创建并 fsync 0600 owner proof → 更名为真实目录 → 原 registry 非激活追加 → 持久 registered。SQL namespace 未包含在这次操作内，两份 Native 文件也没有伪装成原子提交。

原 registry 和新 journal 都在原固定 `wx` staging slot 持有期间比较旧原始 bytes，再 rename；陈旧进程不能覆盖其他进程已提交的 workspace selection 或 allocation。额外固定 `desktop-plugin-project-allocation-lock.json.pending-v1` 是真实排他操作 lease，大小限制为 1 KiB，覆盖分配和恢复的整个同步操作；内存 mutex 和进程 ID 不授予排他资格。

打开项目不会自动重试 pending/failed。显式 `recover()` 使用同一 owner/ID/目录，能恢复 intent 已落盘、带 proof 的 staging 目录，以及 registry 已提交但 journal 未提交的状态，后者不重复追加或增加 registry revision。遗留未证明归属的目录、软链接、硬链接或旧普通 workspace 不会被收养、移动或删除；proof 未写完的目录保留并失败关闭，需要后续人工恢复策略。

硬退出留下的固定 lease 或 configuration staging 只由原 `discardInterruptedDesktopConfigWrites({ ownsSingleInstance: true })` 在实际获得单实例锁后清理，不被 allocator 偷锁或自动晋升为 committed。已有硬链接、软链接、目录或超限 staging 会保留并继续阻止写入。

## 验证

使用固定 Node 24 / pnpm 10，无 App、服务、业务插件安装或共享 SDK 构建：

```bash
pnpm --filter @crewon/ui exec vitest run \
  electron/localWorkspaceProjectAllocator.test.ts \
  electron/localWorkspaceRegistry.test.ts \
  electron/desktopConfigFile.test.ts \
  electron/localWorkspace.test.ts \
  electron/localWorkspaceReads.test.ts \
  electron/desktopConfigPersistence.test.ts
pnpm --filter @crewon/ui exec tsc --noEmit -p electron/tsconfig.json
pnpm crewon:boundary:check
```

联合六个文件结果：**93 passed、0 failed、0 skipped**，其中新 allocator 文件 47 项。真实文件系统覆盖原活动读取与新增分配并行、冷启动重放、完整 owner 隔离、同实例 proof、拒绝 legacy 收养、坏 journal/目录/lease、原 roster 上限、registry/journal CAS。实际第二 Node 进程覆盖整个分配排他、陈旧 registry 写、分配中普通 select，以及 release 时文件/硬链接/软链接替换后保持原文件。实际 SIGKILL 覆盖 intent、已有 proof 的 staging 和 registry commit 后恢复。registered intent 的原 registry 文件或 project entry 缺失也按同 ID 恢复，并保持当前活动绑定。这些证据不替代 Native 到 Control/中央 Agent 的最终接线验收。
