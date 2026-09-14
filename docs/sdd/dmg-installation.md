# DMG 打包与安装验收

## 当前安装包：0.1.5，已安装并完成本机验收

2026-09-14，已从校验通过的 DMG 覆盖安装到 `/Applications/CrewON.app`，保留原用户数据与旧 App 备份。正常退出再启动后，登录、工作空间和会话分组恢复正常。

- [CrewON-0.1.5-arm64.dmg](../../apps/crewon-ui/release/CrewON-0.1.5-arm64.dmg)：175,842,107 字节。
- SHA-256：`f6982bd8c4833825805304e145400e8c7dccda0035ebb7ef29551c00ace0480a`。
- 镜像与安装目录的 ASAR SHA-256：`998cea5aee798b434f8bcb1bd90ffc47221741b72bbc46be9cba4842319b4670`。
- 完整 UI：445 文件、3129 项通过；UI/Electron 类型检查、入口边界、完整 DMG 构建与镜像校验通过。见 [最终检查记录](evidence/desktop-0.1.5-checks.json)。

### 实际安装版操作

1. 点击工作空间加号，通过原生目录选择器新增 B，原来的三个空间保留。分别在 A、B 单次发送新任务，真实模型读取各自目录中同名文件，分别返回 `CREWON_WORKSPACE_A_20260914`、`CREWON_WORKSPACE_B_20260914`。两个会话各产生一个完成的 Run，数据库中的工作空间 ID 不同，切换及重启后仍分组正确。
2. 图片任务实际生成 2,041,789 字节 PNG。生成进度、图片预览和保存入口已验证；最终 0.1.5 正常退出重启后再次加载图片，点击“保存图片”完成原生保存对话框，文件摘要与原附件完全一致。详见 [图片生成与界面证据](evidence/installed-image-gui.json) 和最终检查记录。
3. 重启无需重新登录；新任务首次发送正常；两组无用消息/列表导航已经移除。应用最终保持打开，显示已生成的图片。

本轮验收还发现并修复：新会话首次发送被历史恢复请求打断、会话列表摘要遗漏工作空间归属，以及过期读取失败误禁用工作空间按钮。原生权限确认失败仍拒绝切换，不放宽目录权限边界。

### 图片流与运行服务验证

0.1.3 起，图片 base64 不再作为普通文字处理；生成状态及时显示，图片加密保存为附件，支持认证预览和保存。每图最多 8 MiB，普通文字按 100 ms 刷新。工具按会话固定目录执行；切换空间不重启服务。Finder 最小 PATH 下缺少 Git/pnpm 不再阻止文件工具与整个本地服务启动。

0.1.5 的 7 个 runtime bundle 与 0.1.4、0.1.3 一致，后续修复仅涉及 UI。0.1.3 的 Worker 484、Control API 232、相关 packages 1270 项测试及相关类型检查通过，外部环境依赖测试按原条件跳过。历史检查见 [0.1.3 记录](evidence/desktop-0.1.3-checks.json)，其中当时“锁屏待验收”的状态已由上述实际安装操作完成。

独立包内服务测试还验证了最小 Finder PATH、A/B 目录分派与服务重启。真实提供方 gpt-5.5 在 2.95 秒发出图片进度，31.0 秒生成 1,806,045 字节 PNG，重启后认证下载逐字节一致。见 [包内模型记录](evidence/packaged-image-smoke.json) 和 [实际产图](evidence/packaged-image-smoke.png)；该测试与上面的实际 App 图片任务分开记录。

没有把 API key、密码、用户数据库或环境文件放入安装包。保留本机 ad-hoc 签名；Developer ID 签名和 Apple 公证尚未完成，本结果属于本机安装验收。使用方法见 [App 使用说明](../crewon-app-user-guide.md)。以下为历史记录，当时的“未验证”描述不代表当前安装状态。

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
