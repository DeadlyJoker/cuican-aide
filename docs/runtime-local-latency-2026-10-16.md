# 本地执行耗时与多会话调度：2026-10-16

## 结论与范围

本轮在 macOS、Node 24.18.1、pnpm 10.33.0 上，使用独立临时 SQLite 数据库、真实应用服务、执行租约、工具回执和 HTTP/SSE 做对照测试。模型使用可控 transport 或本机 Responses HTTP fixture，以排除云端模型和公网延迟。没有修改用户数据库、安装包、服务配置或生产数据。

当前 HEAD 已有 worker 池，生产入口默认并发 2，库默认并发 1；不是整个产品只有一个执行槽。已有 outbox 文件提示和游标恢复，也不是所有输出都依赖一秒轮询。最初仅从单个 RuntimeWorker 推导全局串行的判断不成立。

实测确认的瓶颈是：空闲槽领取新工作和已完成槽领取后续工作依赖扫描；工具整批执行结束后才开始提交结果。SQLite 的多次状态校验确有成本，但在本轮小规模样本中不是主要等待来源。

## 对照结果

以下是隔离测试的一次原始样本，不是生产 SLA，也不是多轮统计百分位。

| 阶段                                     |                  修改前 |       修改后 | 测量边界                                           |
| ---------------------------------------- | ----------------------: | -----------: | -------------------------------------------------- |
| 空闲时提交两会话至两者进入模型 transport |                 906.6ms |       46.9ms | 含应用提交和上下文准备，默认 1000ms 扫描           |
| 释放第二会话至第三会话进入 transport     |                 868.8ms |       21.5ms | 第一会话持续运行，并发峰值保持 2                   |
| 快工具执行返回至结果持久化               |            至少约 296ms |     约 5.8ms | 两个并行工具，后一个受控为约 300ms；按调用顺序提交 |
| 已提交事件至独立 HTTP/SSE 客户端         | 既有机制，本轮验证 17ms |     机制保留 | 独立写进程，扫描间隔设为 60 秒以排除扫描巧合       |
| SSE 断线后下一事件回流                   |  既有机制，本轮验证 6ms |     机制保留 | 按最后事件序号继续读取                             |
| 文件提示不可用时 SSE 回流                |                   816ms | 降级机制保留 | 1000ms 持久扫描兜底                                |

工具测试的阶段标记均来自单调时钟，避免 fixture 的业务时间影响计时。最终验收样本：第一次本地模型 HTTP 请求在 66.3ms，工具开始在 96.0ms，快工具返回在 102.5ms、提交在 108.4ms；慢工具返回在 397.5ms、提交在 401.2ms；下一次模型请求在 425.2ms，Run 结束在 454.8ms。另一轮空闲调度样本为 22.9ms，执行槽补位为 21.2ms。

另一轮低负载样本中，45 次 loadRun 共约 5.6ms、21 次续租共约 6.5ms、两次工具结果提交共约 5.1ms。这些是各操作累计耗时，不能将有重叠的区间直接相加当成总延迟，也不能由此排除大数据库、磁盘压力或网络数据库的慢查询。

另有真实 Node 子进程读取仓库文件的测试，分别输出文件读取、进程调用和完整工具续跑耗时，避免把受控延迟工具当作所有真实工具的性能代表。

## 实际命令适配器的额外瓶颈

另行通过真实 `createLocalWorkspaceCommandToolRuntime` 执行获准命令：独立的 `cat sample.txt` 约 35.4ms；先提交约 300ms 的 sleep 命令，再从另一 Run 提交同一文件读取，后者耗时约 347.5ms。该等待由适配器实例共享的 `commandQueue` 产生，独立于模型和 worker 池。

这个队列保护共享工作区内任意 shell 命令的文件副作用顺序，本轮保留。两个会话可以并行模型处理和使用支持并行的工具，但共享同一个命令 runtime 的写入不能因此安全并行。后续子 agent 的文件操作需要独立工作目录或资源作用域；不能仅根据看似只读的 shell 文本放开串行保护。

## 实现

1. 将已有 SQLite 文件变更观察器提取为 store 的显式 API，control-api 保留原接口。工作池复用同一观察机制：文件变化只是唤醒提示，真正执行必须领取持久队列并重新验证身份、能力和租约。WAL 替换、提示失败和关闭行为保持原有覆盖。
2. 每个独立 worker lane 配置一个有界 pump。一次运行、一个 dirty 标记、一个待执行回调合并提示；工作完成后让出事件循环并立即补位；空队列停止连续领取。原扫描保留，供提示丢失、不可用和未来到期重试兜底。关闭 pump 禁止新调度，worker 继续负责中断和等待实际执行。
3. 工具批处理改为有序异步结果流。并行调用同时启动，已完成的调用顺序前缀立即提交；串行调用先提交并确认当前结果，再启动下一项。失败、取消或提前退出时，生成器 finally 等待所有已启动调用，避免租约先于真实工具释放。
4. 保留同一会话活动 Run 不变量、事件序号、结果回执、幂等键、输出投影及模型上下文顺序。没有变更 HTTP、事件或持久数据形状，没有新增运行时和产品依赖。

慢的首项仍会阻止后续项越序写入标准历史；本轮消除的是“已完成前缀等待后续慢项”。没有用新增临时完成事件绕开现有协议。

## 参考与后续边界

参考本机静态逆向材料 `chatgpt-analysis-26.1007.71326/reports/desktop-host-and-app-server.md` 中的宿主队列、调度切片和运行身份边界，以及 README 中的流式恢复分层。没有复制其私有协议，也没有把静态分析当作 ChatGPT 实际吞吐和并发参数的证明。

这些改动为子 agent 提供独立执行槽、及时结果提交和可恢复读取的基础。自主创建子任务、父任务等待时释放执行槽、持久父子关系、预算与取消传播仍需单独实现。PostgreSQL 没有本地文件提示，保持持久扫描；本轮没有验证真实 PostgreSQL 环境。

用户已有桌面数据仅做只读核对，所查数据库的最新 Run 记录停在 2026-10-12，不能代表本次 HEAD。其“总时间减模型区间”还包括工具、审批和恢复等待，不能等同于本地框架纯开销。

## 复现

使用项目要求的 Node 24，并先安装依赖、构建 plugin-sdk：

```bash
pnpm install --frozen-lockfile
pnpm --filter @crewon/plugin-sdk build
node --test --test-concurrency=1 \
  apps/runtime-worker/src/runtime-local-latency.integration.test.ts \
  apps/runtime-worker/src/local-workspace-command-tool-runtime.test.ts \
  apps/runtime-worker/src/runtime-worker-pool.integration.test.ts \
  apps/runtime-worker/src/runtime-worker-pump.test.ts \
  apps/runtime-worker/src/resolve-tool-batch.test.ts \
  apps/control-api/src/runtime-worker-streaming.integration.test.ts \
  apps/control-api/src/sqlite-outbox-streaming.integration.test.ts \
  apps/control-api/src/sqlite-outbox-wakeup.test.ts
```

基线测量在修改执行和调度代码前完成；受控测试本身及观察回调不构成生产遥测。重负载下计时会随主机调度变化，正确性以任务隔离、序号、持久结果和未重复执行的断言为准。

## 主机负载和验证限制

并发运行大型回归时，真实子进程读文件样本的总调用约 464.6ms，而子进程内文件读取约 8.4ms；完整工具续跑约 855.6ms。差额包含进程启动、调度和管道回收，不能算作文件读取本身。同一受控工具结果的返回到提交也从数毫秒升到数十毫秒。主机当时还有其他高 CPU 进程，本轮未停止或修改它们。因此性能评估必须同时记录主机负载。

全量 control-api/runtime-worker 回归尝试已发现冻结插件 fixture 缺失：例如 `short-drama-media-worker-20261006/short-drama/21.0.1`、`short-drama-media-handler-20261006/short-drama/21.0.0`。相关未修改用例单独运行也在安装 fixture 的 lstat 阶段以 `plugin_package_filesystem_unavailable` / `ENOENT` 失败。全量运行在确认该环境缺项后停止，不能报告为全量通过；没有伪造或替换冻结插件包来消除错误。

专项覆盖工作池并发上限、独立取消、关闭收尾、SQLite 冷读、HTTP/SSE 双会话、最终历史、游标重连、提示风暴及空队列收敛、工具结果有序提前提交、失败时等待兄弟调用，以及容量压力、崩溃恢复和上下文连续性。PostgreSQL 用例因未配置测试库跳过。没有完成安装版桌面 UI 的交互验收，也没有发布安装包。

最终定向验收：调度、结果提交和 HTTP/SSE 共 25 项通过；真实命令适配器 9 项通过；工具恢复专项 22 项通过、19 项 PostgreSQL 用例跳过。worker、control-api、store 类型检查及仓库边界、格式检查通过。复测期间曾因子进程启动超过既有 fixture 截止时间而失败；负载下降并使用隔离 Node 编译缓存后，最后一轮 25 项全部通过，未延长截止时间或弱化断言。
