# 打包应用的短剧插件安装与项目输入

日期：2026-10-04。状态：实际 `.app` 窗口专项首次 **1/1、零跳过、退出码 0**，最终与原 Source、报告及编译窗口组合 **九文件、36/36、零跳过、退出码 0**。完整增量插件目标继续 ACTIVE。

本阶段使用原 macOS arm64 `CrewON.app`、原 manifest/main、preload、窗口、Resources/runtime 和逐字节复制的正式 Renderer。复用[真实打包装配](./native-packaged-report-window.md)，通过原 `--user-data-dir` 启动私有目录，外部 inspector 只观察已运行的原 Main；不重建 SDK、正式前端或保留的独立插件包，不改原账号、Settings、侧栏、样式、网络或 fuses。

验收对象是独立 `crewon.short-drama` **9.0.0**，摘要为 `sha256:981c3bcdb7fc9c47186118a482bb1d8ec3dd1d4f95d3a09139f7a104dfba2334`。该包必需项目和恢复 Host 服务，使用现有 Native 项目执行装配的真实 owner；不以无依赖的早期 UI 包替代。短剧仅作为批准来源留存，初始没有安装选择，首装必须由原 Settings 页面完成。

实际操作顺序为：原用户栏进入十类设置→工具与扩展→安装（默认停用）→明确启用→原侧栏短剧模块→保存项目及概念输入→关闭项目重新读回→原 Main 物理退出→新 Main 冷读取相同输入→原设置停用并撤下模块→卸载→同一来源重新安装、启用→读回原项目与输入。卸载是原逻辑选择操作；全部保存身份、需求、概念修订和元数据幂等回执需保持逐条相同。

测试只为旧命名模型夹具增加显式目录 GET 选项，使用实际 HTTPS、原鉴权和零请求体；没有选项时保留旧 POST-only 行为。原 Main 的模型目录探测与模型执行分别记录，不能把目录成功视为生成成功。

沿用的 Native 项目夹具已有明确具名的 100 积分资金记录，本阶段不新增资金、不修改报价、不消费或预留，不能称“没有资金设置”。实际业务动作只允许一次创建项目和一次创建概念输入；生成、显式供应商查询、图片选用、Thread 创建、恢复 stage、Run/准入/预留、报价、模型执行和供应商请求增量必须为 0。资金与策略夹具不代表真实用户授权或收费。

本阶段以 `70296ae86dbd452d0942f26d9829586b2e5d5eea` 保留原前端，不声称全部等于最初 `776484c57`，不修改 primary 的人类工作。项目输入冷读取不是三条未确认请求的 prepared/hydrate 验收，也不是短剧在线 S0。Native Krea2 实际公网生成/原 operation 查询、同次原完整 App 保存→生成→显式查询→选用→重启恢复、真实个人钱包/资金/价格/结算、全部插件打包链路及用户选定实际企业 API 的 E5 仍需完成。

专项入口为 `apps/crewon-ui/electron/desktopInstalledPluginRuntime.packaged-projects.integration.test.ts`。首次实际证据在 `output/extensions/checks/native-packaged-projects-app-first-20261004/`，最终证据在 `output/extensions/checks/native-packaged-projects-app-final-20261004/`，各包含十张页面截图及 `native-packaged-projects-app-proof.json`。最终组合包含短剧、编译报告和打包报告专项，不相加其他历史组；Host 类型、boundary、格式与保留检查通过，实际结果和文件摘要归档为 `output/extensions/checks/native-packaged-projects-proof-20261004.json`。
