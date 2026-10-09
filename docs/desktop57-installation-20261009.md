# 桌面 0.1.57 正式安装状态

## 实际操作

用户解锁后，正常应用菜单退出 0.1.53；退出进程确认结束后，在原数据目录外保存数据库备份与业务表摘要，保留一份 0.1.53 应用回退。将已冻结并签名核验的 0.1.57 候选替换到 `/Applications/CrewON.app`。实际 archive 和七个运行时摘要与候选证明一致，严格签名通过。没有清除、改写或绕过原账号凭据。

第一次启动卡在 macOS 钥匙串读取，进程采样定位到 SecKeychainItemCopyContent。用户在本机完成授权后，实际 App 恢复 admin 管理员、原 CrewON图片验收工作空间及原小说会话，主页模型仍为 gpt-6-astra。已看到此前 v6 大纲读取结果，未发送新的保存指令。

通过原设置“工具与扩展”入口预览并添加冻结短剧 47 来源：完整摘要 `sha256:5573dd289c61f4f3934c2a8f538beff9e8740756c410e44efeaddcd2b96321fa`，选择原 Node、ui.mjs 和参考图资源。来源已经写入原审批文件，但添加来源后的运行服务没有恢复，设置显示“设置暂不可用”。此后工具再次报告 Mac 锁屏，正常重开操作尚未完成。

只读确认原 profile 仍启用短剧 45，selection revision 37，摘要 `sha256:9c0649ee789f3b67b4ef1a44aa29973d2aba68ccdc186bcd92c7ef18c6dbe6e5`；47 只完成来源添加，未安装/切换。实际审批配置通过 Native 原解析器检查，但 Control 的 desktop-plugin-configuration 还没有接受 projectOutlineTools 字段。用当前实际审批内容进行只读投影，旧 Control 解析器复现 desktop_plugin_configuration_invalid；源码补齐 v3 独立字段、源摘要及 UI 元数据对应检查后接受。原 v1/v2 继续拒绝这个字段，Foundation 或 UI 声明不会隐式授予它。Native 实际私有文件写入/Control 读取、文件寿命与旧权限边界回归共 16 项通过，Control 类型检查通过。这是已确认的启动配置缺口；0.1.57 尚未包含修复，修复包重开后还需实际核验是否有其他启动问题。

## 证据与限制

干净验收工作树 `output/extensions/desktop57-delivery/` 保存 installation-proof.json、pre-install-business-proof.json、pre-install-control.sqlite 与 previous-CrewON-0.1.53.app。安装前快照在应用关闭且数据库无人持有、WAL 为零时取得，完整性检查通过。当前正式应用为 0.1.57，短剧仍为 45。

下一步优先恢复原运行环境，确认设置可用，再沿原安装器切换 47 并验证真实模型保存。没有重复提交原不确定 Comfy 操作，没有新的媒体生成，没有把源码/隔离测试当作正式产品验收。原管理员登录和原项目须继续保持。
