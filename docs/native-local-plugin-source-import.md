# Native 本地插件来源导入

桌面端在原「设置 → 工具与扩展」中增加「选择本机插件目录」。选择的是独立构建后的包，包含原 `crewon.plugin.json` 和声明的产物；不要求开发目录属于 CrewON 仓库，也不修改开发目录的权限或文件。

Main 使用原生目录选择器和原包校验器读取字节。预览只返回插件、声明发布者、版本、完整摘要、入口及可选择的文件清单，不把本机目录路径交给 Renderer。发布者字段是包的自声明，摘要校验不证明发布者签名。Web、URL 中的 `surface=desktop` 和旧 preload 都不能提供这个 Native 能力。

用户确认完整包身份和信任范围后，Main 把精确命令锁定为一次性意图，再经原 Supervisor 重启队列物理停止当前 runtime。预览组件因原 Control client 或本机管理会话更新而卸载，不会取消已经明确接受的意图；真正的 Main 文档导航、崩溃、关闭和外部会话失效仍撤回并等待在途工作。所有校验和复制完成后，才能提交审批。

原 installer 将校验过的包复制到 Main 私有 `plugin-import-sources`，与实际安装目录分离。installer 的原安装副本仍为 0555；导入器仅把自己拥有、精确摘要路径的来源副本根收紧为 0500，以满足原来源注册器的 owner-only 目录要求。Main 用 nofollow 目录 fd 核验 inode/dev/UID 后调整权限，并复核 fd、路径和父目录；开发目录不变。固定 `plugin-approvals.json` 使用原 v1/v2/v3 严格解析器追加来源；保留原 publications、项目配置和已安装选择。审批字节、文件身份和父目录都参与提交前复核，拒绝重复来源、版本、摘要、发布者变化、路径替换或并发审批改写。审批和包仍有原大小及数量限制；该防护不宣称隔离任意同 UID 写者或可信 Node 代码。

界面资源默认一个都不公开。用户明确选中的文件必须来自校验过的清单；公开 UI 时必须包含 UI 入口，排除 Node 入口和业务 manifest。`trustedModule` 还需要单独确认共享 Renderer 权限。当前 `isolatedWeb` 只允许添加安装来源，不宣称已支持其 UI 加载。信任 Node 不授予模型、网络、项目执行或计费权限。

添加来源不创建安装选择，不启用插件，也不执行插件。之后仍用原来源列表显式「安装 → 启用」，初始停用规则不变。个人积分、价格、模型凭据、外部供应商以及业务配置继续使用原协议，不由导入器生成默认值。

Main 只在当前原窗口文档内保留一个导入状态，绑定明确确认的 opaque previewId 和完整包身份。v1 client 可选的 `readStatus` 与单独状态通知支持 pending/committed/failed；旧 v1 client 保持原调用方式。Renderer 在组件外仅保留同 preload client、账号键的一个票据，设置或 AuthGate 重挂后先订阅再读回，不重放确认。明确确认导致整个 App 重挂时，回到原「工具与扩展」一次；正常浏览、预览或旧 preload 不触发导航。账号变化、外部 owner 失效、真正文档导航和关闭撤回票据，原 runtime 与 AuthGate 权限仍在 stop 时失效，不保留访问权限。已提交回执先于 importer 清理保存；清理或 IPC 传输失败不覆盖 Main 已提交结果，读回 pending 时继续等待。

审批已提交而原 runtime 启动失败时，返回已导入且待重启的回执，不回滚审批或删除开发文件。首次审批的独占硬链接提交若只剩 staging 清理失败，冷启动仅在单实例 owner、两个精确私有路径、同 inode/dev、恰好两个链接、完整审批字节和父目录身份全部吻合时移除 staging；不自动批准尚未提交的文件，不清理身份不明的残留。确认失败留下的私有包副本不能自行变成批准来源。

当前入口适用于已进入原 App 的登录用户，或已有明确本机管理审批的 Native 用户。没有任何审批且企业账号签出的首次启动仍遵循原 AuthGate；这次没有扩大登录或本机身份权限。独立组件支持 Control catalogue 尚未连接时校验目录，不能以此代替首次完整 App 可达性验收。

最终窄回归分别为 Host 六文件 **152/152**、UI 十九文件 **199/199**，均零跳过；两组独立记录，不求和，不代表全量 UI 已通过。Host 覆盖 Main 状态生命周期、真实来源注册器列出/解析、原 SQLite 安装默认停用、未批准副本重试及目录替换拒绝；UI 覆盖组件、原设置与侧栏、票据撤回、重挂读回及一次设置恢复。日志分别为 `output/extensions/checks/native-import-receipt-host-pipeline-final-20261004.log` 和 `output/extensions/checks/native-import-receipt-ui-shell-final-20261004.log`。

真实 macOS `.app` 的手动 CUA 暖/冷验收已完成，证据在 `output/extensions/checks/native-local-import-packaged-accepted-20261004/`；这是原窗口、SQLite 与 OS 进程验收，不记为 Vitest 的「1/1」。暖阶段从原用户栏进入设置，由真实 macOS 目录选择器选择初始未批准的独立短剧 1.0.0 包。默认无 UI 公开/信任勾选，仅明确批准 `ui.mjs` 与 PNG 并确认 UI 信任；Main 自重启后原「工具与扩展」及已添加回执恢复，原目录显示两个来源。预览不改审批和安装记录，添加来源时安装记录仍为空；之后从原页面显式安装，初始 Disabled、revision 1、一个安装回执，再明确 Enable，变为 Enabled、revision 2、两个回执。返回原侧栏加载真实插件页面及 PNG，开发来源的文件摘要与权限保持。

暖 Main `7794` 正常退出后，测试仅在自有目录将选择来源与私有导入来源改名下线，保留同 inode 与原权限，审批不变；独立的 0555 安装副本仍完整。新 Main `58526` 使用同 `.app`、asar 和 userData，自然 `isPackaged=true/defaultApp=false`，asar 摘要吻合。原侧栏从独立安装副本加载演示 UI 及真实 PNG，原用户栏再次进入十类设置，Installed 仍 Enabled；Available 只显示在线的保留来源，缺失的 1.0.0 来源不再列出。上次 Main 的内存导入回执不跨进程保留，也未自动再导入、安装或启用。暖/冷的安装记录、两个回执、revision 2 选择、审批与业务计数逐项相同，两个 Main 均经原退出操作自然退出且 exit 0，真实 Control 子进程退场记录保留。

最终统一证明为该目录的 `accepted-proof.json`，对应 `output/extensions/checks/native-local-import-packaged-accepted-proof-20261004.log`。它严格比较暖/冷审批 SHA、三表完整记录和业务计数，核对编译源码与最终正式 Renderer 文件摘要同打包证明一致；五个专项 PID `7794/7948/20165/58526/58575` 均已复核 ESRCH，四次自有临时根已清理，九张最终截图保留。汇总脚本首次误读 `copiedRenderer` 字段，在只读检查阶段失败，未提前清理；改用实际 `rendererFiles` 后最终退出码 0。最终 boundary 检查也退出码 0。

本专项的 Thread、Message、Run 和外部 operation 记录均为 0；积分、任务准入和项目相关 schema 未建立，证据为 null，不能解释为真实钱包余额为 0。独立短剧 1.0.0 验证的是安装协议、页面和 PNG 的暖/冷加载，没有执行生成，也不代表短剧 9/10 的完整业务能力或真实资金验收。

最终只读保留审计 `output/extensions/checks/native-local-import-packaged-final-preservation-20261004.json`（SHA-256 `3c7d4f6d95d9c63644caaa3c54e0fc6855f318a078a29483359b74a1aee0a5f9`）确认 13 个受保护原 UI 文件、60 个 SDK 源文件及冻结 tarball、九个原发行包、0600 生产映射、五个原用户 PID 的命令与监听、primary 人类工作保持本轮基线。13 个 UI 文件不包含本轮增加五行恢复接线的 App；正式 Renderer 有意重建以包含新增能力，不声称旧 15 资产字节未变。

本轮没有修改全局 CSS、原 AuthGate 或账户菜单。用户当前原 IAB 服务 `5730` 已实际从账号菜单进入十类设置；`5719` 根地址显示原 AuthGate 登录页，不能混作同一已登录界面。完整目标仍为 ACTIVE：用户原 ComfyUI 此前返回 404，本轮未反复探测或提交生成；真实个人身份、积分入账、价格与结算，同次完整 App 的在线短剧 S0、Native Krea2 公网生成/查询、全部插件打包链路和实际企业 API 的 E5 仍未完成。
