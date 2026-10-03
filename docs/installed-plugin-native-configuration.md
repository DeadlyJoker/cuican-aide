# 桌面端已安装插件的业务配置

正式桌面端复用原“用户栏 → 设置 → 工具与扩展 → 已安装插件 → 业务配置”表单。配置能力由 Native 明确开启的安装组合提供；默认 standalone 入口保持原行为，不创建插件配置表或新增插件路由。

## 配置与授权

同一个实际 `StandaloneIdentity` 同时服务原 Control HTTP 路由和插件配置请求。读取和保存重新核验实际 loopback 会话、Origin、变更请求的 CSRF、完整 principal/actor/tenant/space 及 Native profile；Renderer 不能指定另一个 profile 或身份。配置组合要求安装协调器使用同一个真实父 Store、权限实例和已验证注册表，并观察实际 SQLite profile 锁及文件标识；所有权丢失后，读取、新保存和旧回执重放均拒绝。

元数据只来自真实选中的安装副本。宿主验证 publisher、plugin、version 和完整包摘要，并再次检查选择账本和实际业务 JSON。停用但仍选中的包可以配置；已安装的其他版本不能替代选中版本。交付来源离线后，批准仍有效的安装副本继续可读。卸载、改选、损坏或批准范围变化不能被另一个版本或旧 Worker 的目录补齐。

业务配置仍沿原 `crewon.extension-configuration.v0` 的 tenant/space/plugin 作用域保存，不改公共 HTTP、SDK 或持久数据形状。CAS、原请求键重放及结果未知后的同键重试沿用原服务。原配置回执先于新元数据准备读取，因此以前成功的同键请求可以确认；新保存必须核验当前选中包。凭据引用不代表实现了凭据租约，当前 Native 配置组合拒绝非空引用。

读取配置和保存参数不授予执行、查询、发布、启用或个人积分权限，不创建任务。原 SQLite 扩展迁移会同时创建外部操作表；本路径不写操作或积分记录，不能将“没有记录”误写成“没有这些表”。`DesktopPluginRuntime.close` 同步撤回权限，等待已开始的实际工作结束后才释放 profile 和关闭父 SQLite；原 HTTP server 的请求退场顺序保留。

## 与旧扩展共存

已有 Worker 的目录、配置、任务与历史查询保留原服务路径。Native 明确批准的 plugin ID 及安装账本保留的命名空间使用安装协议，不回退到旧 Worker，包括撤回全部批准、停用和卸载后的旧查询及成功回执。双方使用相同 plugin ID 时启动拒绝，避免由安装顺序决定权限来源。组合目录仍受原 32 项上限约束；不启用 Native 安装组合时，旧入口没有额外 profile 或元数据读取。

停用状态切换包版本只验证字节和兼容性，不加载 Node 服务。启用仍执行原 activation 校验和生命周期，不将“选择了新版本”视为已启用。

## 验证命令与范围

使用仓库指定的 Node.js 24 和 pnpm 10：

```bash
pnpm --filter @crewon/ui test:installed-plugin-native-configuration
```

专项先串行构建正式 UI、七个桌面 runtime bundle 和 Electron Main/preload。唯一 SDK producer 随后在仓外构建独立报告包，实际删除开发源码、依赖和 SDK tarball 后才启动消费者。需要保留证明和截图时设置 `CREWON_NATIVE_APP_EVIDENCE_DIRECTORY` 为自有绝对目录。

消费者使用独立私有 userData 和明确批准文件，导入原 Main、加载原 file 页面和 preload，取得真实本机会话；在原设置中安装停用的报告包、保存参数，再物理退出 Main/Control。第二个 Main 进程在来源离线后打开同一个 SQLite，从原设置读回相同参数、修订和回执。坏包目录硬失败，不替换为合成成功。

这项验收涉及真实 file App、原设置、SQLite 和源代码 Control 子进程，当前实际运行环境为 macOS；进程退场观察依赖 Unix `ps`。它不证明 packaged `.app` 的生成、实际企业登录、在线模型/供应商、真实资金结算或短剧项目保存。后续执行与收费需要独立准入，不能用本机管理身份充当个人付款主体。当前实施结果见[实施进度](./incremental-extension-progress.md)。
