# 桌面 0.1.58 与短剧 47 正式安装核验

## 已恢复的实际入口

0.1.58 已替换到 `/Applications/CrewON.app` 并正常启动。修复 Control 启动配置没有接受 Native 独立 `projectOutlineTools` 声明的问题；旧 v1/v2 配置继续拒绝新字段，声明仍核对确切来源摘要和 UI 元数据。Native 私有写入到 Control 读取以及兼容、授权回归共 16 项通过。运行源码提交为 `a678398f9`，干净打包提交为 `9f16e149b`。

候选及正式包的签名、archive、header、Main 与七个运行时摘要核验通过。原 15 个 renderer 文件（包括四个 CSS）、preload、原 HTTPS 登录地址均保持。安装前沿正常应用菜单退出 0.1.57，在原数据目录外保留数据库及应用备份；没有清除、改写或绕过凭据。正式界面显示原 admin 管理员、CrewON图片验收工作空间、原小说会话与此前 v6 结果，原设置“工具与扩展”再次可用。

## 原插件管理安装与接力

使用原设置安装冻结短剧 47，摘要 `sha256:5573dd289c61f4f3934c2a8f538beff9e8740756c410e44efeaddcd2b96321fa`。先停用 45，再选中 47，沿用原 ComfyUI 地址和 krea2-portrait 参数保存配置 12。经原执行预览沿用已授权 Node 和服务范围，没有开启新的参考图上传许可或提交生成。

执行批准保存后，原界面曾显示“准备未完成”；读取 Native 实际准备结果为 prepared，随后通过原启用入口成功启用 47。正式 selection revision 为 40、状态 enabled、版本与摘要匹配。这个准备提示与结果的差异仍需进一步定位，不能计为完整准备体验通过。

实际插件默认首页区分想法创作、小说创建和继续项目。打开原“小说流程验收 · 来信”，概览显示真实改编目标、已确认方案、故事大纲入口。点击继续对话后，原系统明确提示旧插件关联过期；通过“更新关联并进入”恢复同一原线程与工作空间，主页共享模型/权限/执行主体和项目阶段操作保留。

## 真实模型执行

通过原主页对话选择大纲阶段，以 gpt-6-astra 请求仅润色一句话主线并保存候选，Run `plugin-ptoEfOVDWHRebRdXnfe5FUOGXsfdCbq00dRuQvfMc9E` 在首个模型请求返回 `responses_provider_invalid_prompt`；没有工具执行或新候选。随后明确选择目录内 gpt-5.6-sol 执行同一限定范围，实际不可变执行模型已只读核对，没有使用 GPT-5.5。Run `plugin-M_81fofVTj7_0DHaTYmoQKueiQhlAss8bkVltadpXGo` 已完成 5 次实际工具调用并保存候选 v7；逐字段核对仅 `logline` 改变，原分集和实体 ID 保留。候选未采用、未锁定，真实插件大纲页显示新主线。整个 Run 耗时约 359 秒；本地工具累计不到 4 秒，客户端模型链路约 346 秒，包含一次 60 秒空闲超时重试。供应商页面对应 7 次调用合计约 79 秒，差额不能归为模型计算时间，分段响应诊断继续。

## 证据与限制

干净验收工作树 `output/extensions/desktop58-delivery/` 保留 package-proof.json、post-signature-proof.json、installation-proof.json、selected-plugin-proof.json、pre-install-control.sqlite 和 previous-CrewON-0.1.57.app。签名及实际安装验证完成后，已删除仅本次生成的 archive-source 中间目录。

原未知 ComfyUI 操作 `57bc1f09-34a9-7a29-585a-4db37f2f39df` 未重新提交。尚不证明完整八阶段、真实媒体生成或完整产品复刻；新的有序剧本 Domain 与十项 Skill 门提交 `5cfdd1d38` 尚未连接实际保存、Agent 或插件编辑器，也未包含于 0.1.58。
