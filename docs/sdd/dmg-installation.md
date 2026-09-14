# DMG 打包与安装验收

## 当前安装包：0.1.3 图片流与工作空间修复

2026-09-14，DMG 构建和镜像校验通过。新版已从镜像解包并核对 ASAR；Mac 当前锁屏，覆盖安装及最终 GUI 验收等待解锁，不能把包内服务测试写成界面验收。当前 `/Applications/CrewON.app` 仍为 0.1.2。

- [CrewON-0.1.3-arm64.dmg](../../apps/crewon-ui/release/CrewON-0.1.3-arm64.dmg)：175,842,228 字节。
- SHA-256：`043c94072d1c8407cbb78618c580da8dfcc56f54b624e8995a2278a2a1f0ed89`。
- 镜像 App 的 ASAR SHA-256：`1b64a7fae6ae0337e581c7bad41910e61a8e0a3a9a14017c81e26e3319b26acb`。
- 图片流不再将 base64 当普通文字；生成状态即时展示，图片加密存为附件，支持认证预览和保存。每图最多 8 MiB，普通文字按 100 ms 刷新。
- 多工作空间加号新增、会话固定归属、文件工具按会话目录执行；切换空间不重启服务。两组无用消息/列表导航已移除。
- Finder 的最小 PATH 下，缺少 Git/pnpm 不再阻止整个本地服务启动；相关命令在缺少依赖时明确失败，文件工具保持可用。

最终根 UI 全测 445 文件 / 3112 项通过，随后图片引用边界窄测 29 项通过；Worker 484、Control API 232、相关 packages 1270 项通过。外部环境依赖测试按原条件跳过，未放宽规则。全部 packages 类型检查、UI/宿主、Worker/Control 类型检查及入口边界通过。详见 [本版检查记录](evidence/desktop-0.1.3-checks.json)。

直接启动新 App 的 Electron Node 与包内服务，在独立数据目录、最小 Finder PATH 下验证了新增 A/B、服务不中断、会话归属和重启恢复。真实测试提供方使用已有本机凭据：gpt-5.5 在 2.95 秒发出图片进度，31.0 秒完成 1,806,045 字节 PNG；认证下载、实际图片检查、服务重启后再次下载逐字节一致均通过。见 [真实模型记录](evidence/packaged-image-smoke.json) 和 [实际产图](evidence/packaged-image-smoke.png)。这是包内服务测试，GUI 预览与保存按钮仍需解锁后验证。

未把 API key、密码、用户数据库或环境文件放进安装包。保留现有本机 ad-hoc 签名；未完成 Developer ID 签名/Apple 公证，不是公开分发验收。历史记录如下。

## 0.1.1 登录修复历史

2026-09-14，已完成覆盖安装，并在 `/Applications/CrewON.app` 实际确认账号登录、云端资源加载与退出重启后的会话恢复。原用户数据保留，旧 App 备份在 `apps/crewon-ui/release/installed-backups/`。

- [CrewON-0.1.1-arm64.dmg](../../apps/crewon-ui/release/CrewON-0.1.1-arm64.dmg)：175,806,662 字节。
- SHA-256：`fbf9375c07d1f996d7718ed562bc0674ffca20af2718fb89828b71f882cc7787`。
- 镜像与安装目录中的 ASAR SHA-256 均为 `0f581c42b9bb10ef540c22530af519d6674edb7722a51fd51161887cf6e3d76b`。
- 131 项相关测试、UI 与 Electron 类型检查、边界检查、完整 DMG 构建与镜像校验通过。

本次修复两个阻断点：旧包默认连接未运行的 `127.0.0.1:8000`；桌面 HTTP 通道又只允许本机请求。现在桌面构建默认连接 `https://pim.aicuican.com`，并由构建产物中的账号地址清单让主进程只放行该准确来源。保留 HTTPS 校验、请求大小与并发限制、重定向拒绝，以及对其他远程来源的拒绝。

实际界面已显示当前账号和云端智能体列表；正常退出并再次启动后，无需重新输入密码即可回到工作台。企业微信接口可达，但服务端尚未配置企业微信登录；本次验证的是账号密码登录。未在本次重新执行模型业务任务，不能据此宣称全 App 业务验收通过。

7 个包内 runtime bundle 与 0.1.0 的摘要一致。没有把本地环境文件、密码、密钥或用户数据库写入安装包。仍为本机集成验收包，未签名公证或公开发布。详细证据见 [登录修复验收记录](evidence/login-installation-fix.json)。

## 以下为 0.1.0 历史记录

2026-09-14，macOS 15.4.1 / Apple Silicon。应用源码版本 `4fb63a196`，App 版本 `0.1.0`。使用现有 Electron Builder 打包，首次安装时该路径不存在。

## 安装包

- [CrewON-0.1.0-arm64.dmg](../../apps/crewon-ui/release/CrewON-0.1.0-arm64.dmg)：175,807,227 字节，约 167.7 MiB。
- SHA-256：`1ebb5af83e988f65414b7320a4aafd9ea5b3f7cb9e5da48bea0c816ad18bbea6`。
- 已安装到 `/Applications/CrewON.app`，当前窗口停在正常账号登录页。
- 包含 arm64 Electron 43.4.1、Node 24.18.1，以及 7 个本地运行服务 bundle。

打包命令：

```bash
pnpm --filter @crewon/ui run desktop:build --mac dmg --arm64 --publish never
```

机器没有可用的 Developer ID Application 签名证书，App 保留本地 ad-hoc 链接签名，未做 Apple 公证。此包是本机集成验收版，不是完成签名和公证的公开发布版；本机安装与启动过程中没有关闭系统安全机制或清除隔离属性。

## 实际安装结果

1. 完成 UI production build、本地 runtime stage、Electron host build 和 DMG 制作。
2. `hdiutil verify` 校验全部通过；只读挂载镜像，从镜像复制 App 到 `/Applications`。安装前该路径不存在，无旧 App 被覆盖。
3. 镜像中与安装后的 `app.asar` 摘要均为 `11a4bae7c4f5ad0058389452251c737d202bb7bd019f81a2014e5467ba821a3f`。随后卸载镜像。
4. 使用 CUA 打开安装路径，确认窗口加载 `file:///Applications/CrewON.app/Contents/Resources/app.asar/dist/index.html`，实际界面和截图均显示登录页。
5. 从 App 菜单正常退出，确认安装程序进程消失，再次打开同一路径，登录页再次正常显示。最终保留 App 打开。
6. 检查 ASAR 不含本地 `.env`、`.crewon`、模型凭据文件和用户 SQLite 数据库。原用户数据未复制进安装包，也未覆盖。

## 包内运行服务验证

用安装后的 App 可执行文件以 Node 模式启动**安装目录内**的 Control API、Runtime Worker 和 release bundle。测试使用临时 SQLite 数据目录与合成模型配置，无真实模型调用，不读取用户数据库或模型密钥。测试驱动复用 RuntimeSupervisor 和 ControlApiClient，输入为仓库合成订单夹具。

- 包内 Node 与 SQLite 实际查询成功；Control readiness 返回 200。
- 上传两份 CSV 和一份 XLSX 模板，实际生成并下载 XLSX：5 条有效明细、1 条异常，取消订单按规则排除。
- 独立用 SheetJS 读回结果：直营 CNY 180、直营 USD 10、渠道 CNY 150。
- 重启包内服务后，输入仍为 3 份、交付为 1 份，下载文件逐字节相同；重放同一请求返回原版本。
- 临时测试服务已退出；[实际输出 XLSX](evidence/installed-app-output.xlsx)、[运行证据](evidence/packaged-runtime-smoke.json)、[安装证据](evidence/dmg-installation.json) 已保存。

首次运行夹具的占位密钥不足现有校验要求的 32 字节，Worker 正确拒绝启动；随后仅修正合成夹具，产品校验未修改。首次日志与最终日志分别保留在 `/tmp/crewon-packaged-runtime-smoke-first.log`、`/tmp/crewon-packaged-runtime-smoke.log`。打包日志为 `/tmp/crewon-dmg-build.log`。

## 本次未验证

账号登录页显示企业微信服务不可用。本次没有登录账号，没有完成登录后的全 App 人工业务流程；包内服务验证不等于真实模型或企业站点验证。

升级覆盖安装、Intel Mac、其他 macOS 版本、通过网络下载后 Gatekeeper 的分发体验，以及 Apple 签名/公证不在本次通过范围内。使用方法见 [App 使用说明](../crewon-app-user-guide.md)。
