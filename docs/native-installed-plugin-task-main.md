# Native 安装任务的 Main 启动与独立读取

日期：2026-10-04。本阶段接通原 Standalone Main 的私有执行 opt-in、已安装普通 Node task 和原 HTTP 任务读取。原 App、账户菜单、设置、两侧栏及共享样式没有修改。

## 启动边界

显式配置 `CREWON_DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_PATH` 后，Main 在首次文件 await 前捕获数据描述符环境快照。四类任务/UI/执行包/个人报价 authority 的凭据来自明确引用；访问器不会执行，没有 opt-in 时不读取这些凭据。独立配置协议见[任务执行配置](./native-installed-plugin-task-execution.md)。

Main 仅在原 Standalone SQLite 分支接受任务配置。它在 Artifact 或业务 SQLite 分配前加载实际 activation、tasks 和 bootstrap，要求真实 FileIssued/current，并核对 actor、scope、installRoot、bootstrap epoch 和严格解析 publication 的 activationDigest。公开 `createStandaloneControlApiWithPlugins` 在打开 Store 前重复这些核验，程序解析对象、复制、访问器和混用审批均不能跨过此入口。

捕获对象沿原工厂传递，借同一 configuration/request/activation owner 与 SQLite；缺省路径仍保留原 metadata/history 行为。工厂不创建钱包、资金、价格或默认身份。文件读取保留有界 fd、`O_NOFOLLOW`、私有叶文件/父目录、目录身份和权限核验。叶文件变化、目录替换或权限变化撤回批准；祖先目录中无关子文件的创建不应撤回批准。

## HTTP 读取与兼容

原 `GET /api/v1/extensions/:pluginId/tasks/:runId` 的 Native 分支使用实际任务核心的 `ExtensionReadApplicationService` 和独立任务 PDP。读取保持原 configuration request preparation，不启动 execution preparation，不查询 peer readiness，不报价、不创建 Run 或积分预留，也不轮询供应商。

catalog/runtime 仍委托原 metadata reader，保留其原批准和拒绝行为。特别是原 metadata authority 不授予 `agentVersion:read`，不能因为安装了 task opt-in 就把原 runtime GET 的拒绝改成 ready。Native raw HTTP createTask 仍未注册；普通任务经已安装 UI/Node action 和原业务 owner 提交。

混合 legacy/Native reader 在首次 await 前捕获 actor/pluginId/runId，固定所选 reader，并在策略和最后存储 await 后重新检查 namespace/owner。拒绝时不改用其他 reader。当前 Native installation writer 只接受启动时批准的 source，其 namespace 从启动即预留；测试不能假造同 lifetime 的未知插件安装。撤回竞态使用实际 Native authority withdrawal，验证 reader 自身拒绝及原持久安装记录不变。

## 实际验证

新的 Main 进程集成覆盖实际私有文件、原 `main.ts`、HTTPS authority、安装 Node/UI、HTTP/ControlClient 和同一文件 SQLite：

- 提交一次 `image.generate`，七类原持久副作用各新增一次；明确个人测试账户从 available 100/reserved 0 变为 70/30，报价一次。
- 独立任务读取执行 `extension:query` 和 `run:read` PDP，没有额外 peer、报价或持久副作用；撤回任务 PDP 不影响原目录和配置读取。
- 正常关闭第一轮 Main 后启动第二轮，真实轮换 session/CSRF；旧 session/mount 拒绝，新 mount 显式重放原 key、输入和旧 CAS，返回原回执，不重复预留。
- 无 opt-in、任务 PDP 拒绝、错误 session/CSRF、HTTPS authority 拒绝、私有文件变化及实际 profile lock 替换均拒绝；迟到读取在第二次 run-read PDP await 后撤回也拒绝。
- 显式 Native task/PG 配置冲突在新 Artifact 路径创建前拒绝，原 SQLite 副作用基线不变。所有测试子进程和监听端口物理关闭。

测试 Origin 是每次启动明确批准的实际 loopback HTTP Origin，保持 ControlClient 原 HTTP/HTTPS 校验。HTTPS 使用具名测试 CA、五个独立明确 token 和真实传输；task/UI/package/activation 策略、peer readiness、deployment、个人测试 100 积分及 30 积分报价都是测试夹具。

原 startup、Native history/selection/recovery、安装 owner、任务核心和 HTTP 路由回归继续验证兼容。新 startup/read 用例另覆盖缺省无凭据读取、文件 provenance、拒绝前零新 SQLite、混合真实 legacy 投影、调用参数捕获和实际撤权竞态。证据与最终检查结果见 `output/extensions/checks/native-task-main-proof-20261004.json` 和[实施进度](./incremental-extension-progress.md)。

新的 Main/startup/read 组合 **20/20**（8 项真实 Main、6 项 startup、6 项 reader），两类文件 loader **39/39**，均零失败和零跳过。既有 Native/history/recovery/core/HTTP 回归 **183 项通过、零失败**；一项 PostgreSQL creator 用例因没有配置外部数据库跳过，不记为验收。组间存在重叠，不相加。类型、boundary、license 与格式检查通过。

首次夹具的 Origin、直接争抢 profile 锁和对原 metadata runtime 权限的错误预期已修正为实际接口；原失败日志保留，没有修改客户端协议、profile 锁或扩大批准。较大并行回归另暴露了初次配置加载把无关祖先目录元数据变化判为撤权的问题；修复保持叶文件完整 pin 和目录身份/权限检查，并增加确定性真实文件读取覆盖。

## 剩余范围

本阶段没有启动 Worker、调用模型/供应商或使用真实资金；没有再次请求原 ComfyUI 地址，也没有重建前端、SDK 或独立发行包。Electron 私有 challenge/bootstrap 尚未签发新任务配置，当前进程证据不替代 packaged Electron/Main/preload/App 全链路。

下一步联合 Native 短剧实际包接通生成/查询和三类 durable recovery，再接用户真实个人钱包、资金/价格权威及结算。在可用 ComfyUI 上完成同一次完整 App 保存→生成→查询→选用→重启，并完成第二个实际企业 API 的 E5 复用验收。原 createThread 仍不在三类恢复日志内，完整目标继续进行。
