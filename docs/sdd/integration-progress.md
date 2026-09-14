# 隔离集成进度与证据

2026-09-14。协调工作区：`/Users/cheneywang/project/wqc/cuican-aide-sdd-integration-20260914`；分支：`codex/sdd-integration-20260914`。原工作区和各 feature 工作树不修改，未合回 main、未 push 或发布。

## 首批输入与合并处理

- F04 完整消费端提交：`3e3200d47b9f6476d21cde1a7713da895cb19ebf`，作为本次集成基底。
- F03 已提交宿主/身份/导入修复：`33e0a04cd84d5937a0a9b46b48f0545cab4e1e78`，包括 `bd1e2f309` 和 `d6c894f06`。真实模型生成、UI等未提交部分未复制。
- 因 F03 分支带有较旧的 C04 核心副本，15 个文件发生文本冲突。逐块保留 F04 最新的具体参数冻结、readiness、目标范围与兼容校验，合并 F03 的服务、端口导出、路由和客户端传输。
- 自动合并还重新引入 run-now 路由的额外 `getAutomation` 预读，首轮回归使仅有运行权限的旧客户端返回 403。移除该重复预读，保留 application 层的支持版本校验；不能以没有冲突标记代替行为检查。

## 已实际执行的检查

使用 Node 24 与 pnpm 10，独立依赖安装 `pnpm install --frozen-lockfile`；未更换锁文件版本。

窄回归覆盖以下八个文件：

```text
apps/control-api/src/automation-v0-compatibility.test.ts
apps/control-api/src/automation-skill-schedules.test.ts
apps/control-api/src/automation-bff-compatibility.test.ts
apps/control-api/src/demonstrated-skill-adapters.test.ts
apps/control-api/src/demonstrated-skill-routes.test.ts
packages/store/src/demonstrated-skill-integration.test.ts
packages/store/src/demonstrated-skill-store.test.ts
packages/store/src/skill-recording-store.test.ts
```

命令为 `node --experimental-strip-types --test --test-concurrency=4` 后接上述路径。首轮 40 通过、1 失败，原因如上；修复后重跑 41 通过、0 失败、0 跳过。覆盖真实 SQLite 恢复、授权/身份反例、BFF与新旧客户端兼容；其中模型或 Skill 准入使用夹具的部分仍是夹具，不宣称真实模型 E04/E05。

Control API、Store、Control Client 类型检查、OpenAPI 生成一致性和 TypeScript 边界检查已通过。不沿用 feature 各自工作树的测试结果冒称本集成结果。

## 仍待接线和验收

当前已提交 F03 宿主还未给 AutomationApplicationService 注入 skills，也未给 Skill 宿主注入 `scheduledInvocations` 的权威 Run 映射。F04 提供最小接线 patch 和真实宿主垂直测试，由正在修改生成宿主的 F03 统一合入生产接线并提交；F03继续模型生成、UI与录制交接。

F01 换库后的文件交付、F02 完整录制宿主、F05 成熟浏览器动作/显式授权尚未在本树集成。真实模型、浏览器取数、文件结果及完整周期执行的 E04/E05 尚未验收；此树当前用于逐批集成，不作为已可发布成品。

真实浏览器验收当前受锁屏下页面 hidden/焦点不可用影响；显式注意力不足状态与焦点仿真的脚本测试分别记录，不能冒称普通后台/锁屏生产执行已支持。真实模型需使用隔离配置和合成材料，未配置时不把固定模型夹具当作验证通过。
