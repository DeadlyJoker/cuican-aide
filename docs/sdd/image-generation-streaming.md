# 图片生成流与附件交付

## 问题和证据

2026-09-14，安装版的 gpt-5.5 请求等待 49 秒后报 `responses_event_too_large`。对当前测试提供方 `api.aicuican.com` 的受控复现确认：请求已经发出图片生成事件，但应用只处理文字；最终 `response.output_item.done` 中的图片 base64 为 3,552,940 字节，超过原先 256 KiB 的事件限制。该次复现约 3.8 秒开始产图、8.9 秒进入生成、64.6 秒完成；不是用户提示词过长。

## 范围和复用

支持当前桌面使用的 Responses HTTP 流：PNG、JPEG、WebP，每张解码后至多 8 MiB，每次模型请求至多 4 张。复用已有 Responses transport、Run 事件、加密 Artifact store、认证下载客户端与图片卡片，不引入第二套服务或文件存储。

图片模型可能仍需较长时间产图。界面应尽早显示生成状态，产出之后加载预览并允许保存。普通文字流增加 100 ms 刷新窗口，避免不足合并阈值时一直等待终态。

## 契约

- `model.image.progress`：itemId、in_progress/generating/completed。completed 只代表提供方生成阶段结束，界面必须等到可读取的附件引用才显示成功。
- `model.image.generated`：itemId、artifactRef、mimeType、byteLength。事件和模型历史不得存 base64、原始图片或可任意导航的 URL。
- Artifact 的新 kind 为 modelImage，source 为 runId、首次 segmentId、itemId；既有 toolOutput 形状保持兼容。租户、空间和所有者来自可信 Run。
- 按 tenantId/runId/itemId 固定附件身份。恢复重放必须验证摘要、MIME、字节数和归属，复用同一附件；不同输出不能覆盖已保存内容。
- 普通事件元数据仍限制 256 KiB。为容纳四张图片终态重放，图片帧有 48 MiB 总上限，同时执行规范 base64、文件签名、单图与张数限制。

## 显示和恢复

图片进度独立于文字展示，不藏在默认折叠的工具步骤中。持久化进度和生成事件后，重连按 Run cursor 恢复；跨 attempt 的重复事件与历史引用去重。仅有图片、没有文字的成功响应也能正常完成。

前端通过现有认证客户端读附件，校验摘要、长度和 MIME，再创建 Blob URL。退出会话或身份切换时取消下载并释放 URL。加载超时可重试；终态未产生可用文件时显示失败，不能显示空白的成功卡。

图片延用加密存储和 30 天保留期；过期后，仅在可信 Run 已结束且归属匹配时允许清理，运行中不删除。工具输出仍要求原来的工具收据恢复证据。

## 验证范围

自动覆盖大图分块流、生成进度先于结果、身份/序号/格式/大小拒绝、取消、图片-only 成功、加密落盘、认证二进制下载、SQLite 重开与跨 attempt 重放。实际安装版须再验证真实提供方生成、图片可见及保存结果。

当前桌面使用 store=false 的 HTTP Responses。WebSocket 原生图片与 store=true 的提供方 GET retrieve 图片恢复尚未扩展；WebSocket 遇到图片明确失败，不自动重复付费生成。界面重连读取本地持久 Run 事件不依赖这两条路径。
