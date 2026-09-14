# DMG 打包与安装验收

2026-09-14，macOS 15.4.1 / Apple Silicon。应用源码版本 `4fb63a196`，App 版本 `0.1.0`。使用现有 Electron Builder 打包，没有发布到 GitHub 或覆盖已有 App。

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
