# 短剧媒体候选与原供应商请求

2026-10-06。状态：宿主内部的候选占用与原 operation 事务关联已实现，通过234项相关双库回归。安装插件 Tool 服务、实际提交与查询、结果候选回写和 Main/双入口仍继续接线；本协议本身不是网络授权。

## 一份候选，一条原请求

原 `SqliteExternalOperationStore` / `PostgresExternalOperationStore` 保留 v0 operation、幂等重放、状态推进，以及原资金和 Run 检查。对实际 `crewon.short-drama` 的 `media.generate` admission 增加候选占用：真实生成关联的 executionId 与 Run 固定到一次原 Tool reservation。业务 executionId 与 Tool executionId 分开保存，不能靠换工具请求键创建同一候选的第二个供应商请求。

创建时在原 operation 数据库事务内核实际 admission、绑定、原回执和不可变生成关联。原来的个人账户锁先于 Run 锁，候选占用不在这些锁下取得项目锁，也不读文件、上传、执行 HTTP 或借第二条连接。原 operation 与新增不可变 `project_media_operations` 同时提交；最后一条 SQL 后 owner 退场也同时回滚。数据库外的首次输入、字节、独立用途及安装资格检查仍由[Worker 上下文](./project-media-worker-context-protocol.md)和实际 Tool/IO owner 负责。

实际“不扣积分”准入验证原资金凭据，未提供实时 Run 状态检查。媒体新领取因此另在同一事务读取并核真实 Run、原线程和执行目标，要求 running、未请求取消、无 terminalAt；PostgreSQL 使用原 Run 锁及 snapshot 行锁。这个新增检查限定在媒体候选，已有 operation 重放和原请求观察不取得新派发资格。

唯一键为 tenant/Run，并通过外键指向实际生成关联和原 operation。占用固定生成关联摘要、项目/空间、业务执行意图及原 reservation 全部不可变字段。读回核物理索引与摘要，并拒绝多个原 operation、孤立原 operation、缺失/伪造占用、原 correlationId 等不可变字段被替换的情况。原状态与 revision 可以通过已有推进接口更新。

## 显式启用与原路径兼容

`migrateProjectMediaOperations()` 是实际 native operation owner 的显式迁移与启用；构造、普通 `migrate()`、另取一个 owner 都不启用。它要求媒体 Run/输入/准备 schema 和原 operation 表已存在，不补写旧 Run 的占用。成功提交后该实例才报告 `crewon.project-media-operation.v1`。schema 指纹、版本和不可变保护沿现有 owned-schema 检查；部分 schema 或 marker 丢失不能变成通用无占用路径。

非媒体任务和原 operation-only store 保留原契约。媒体 owner 尚未启用时拒绝接受新媒体 operation，也拒绝把该媒体历史当作普通重放。Main/Worker 后续必须显式启用并复用同一个实际实例，不把 DTO 或版本字符串当作执行资格。

## 恢复与新候选

原工具请求键重放返回同一个原 operation，包括它现在的 unknownOutcome、供应商 ID、结果和 revision；重放不取得再次发送资格。不同工具请求键遇到占用返回 conflict。宿主专用 `loadProjectMediaOperation` 按原 Run/绑定读取已占用的原请求，供后续独立观察用途恢复；客户端和模型不能指定替代 operation 来绕过它。

提交中、已受理、结果未知、成功或明确失败均保留占用。该层不释放占用或自动重试。明确新候选需要新的业务 executionId 和原 TaskCore/Run 准入；上游输入变化也不能把旧请求改绑到新输入。供应商实际恢复仍需包内查询适配器、原工具执行身份和受控 IO。

## 验证范围与下一步

检查使用实际 TaskCore、项目/Run、原队列领取和 leased start、双库事务、原资金准入及不可变记录。PDP、工作流部署清单、DNS、供应商返回与报价为具名夹具。新增测试覆盖 T10/D18、同键及不同键竞争、冷启用、unknownOutcome、源变化无素材 I/O、取消/未启动限制、物理插入后的退场回滚、历史损坏及 schema 丢失；回归通用 operation、计费/显式不计费和原工具 IO。

相关回归 **234/234** 通过，零失败/取消/跳过；其中新增28项为子集，不能把相关轮次重复相加。Application/Store/Runtime-worker/Control类型、架构边界和仓库/TS格式检查通过。原SDK源/dist/tar、完整插件包及App的文件核验通过。

首两轮保留了夹具连接字段错误和未来时间造成真实队列无法领取的失败；之后仅对新测试的Task调度使用具名当前时间夹具，原媒体历史时钟及旧测试不变。第三轮真实发现不计费媒体在 queued 状态下仍可领取 operation，补上媒体新领取的Run状态检查，没有放宽测试。四轮自有PostgreSQL正常停止、目录按身份清理，所有运行已结束。

完整结果及原失败日志保存在 `output/extensions/checks/project-media-operation-20261006/`。没有新的远端生成 POST，没有更新 SDK、完整插件包、用户 App 或原 UI。本组件不是正式桌面或完整短剧流程验收。

下一项把该占用与真实 Tool command/invocation、私有 Worker 输入检查和同包 T10/D18 渲染接在一起：第一次只沿原 operation 发送，已有或未知请求只读取并查询原请求。随后接项目候选结果、采用/锁定、Main/Agent 与手动入口，再推进[结构化分镜和有限跨阶段计划](./short-drama-orchestration-spec.md)。完整目标保持 ACTIVE。
