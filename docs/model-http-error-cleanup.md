# 已确定错误与响应体清理分离

2026-10-11 的本轮改动只处理一种已在本地复现的等待：适配器已收到 HTTP 错误，或已确认成功响应的 Content-Type 不符合 SSE 协议，但仍先等待响应体的 `cancel()` promise，再交付失败。

## 改动与边界

新增内部 `cancelResponsesBody`，同步请求取消，并吸收同步异常及异步拒绝；不等待不可信的取消 promise。以下原路径复用它：

- POST 的非 400/404/429 HTTP 失败。
- 原 GET retrieve 的所有 HTTP 失败。
- POST 成功响应的无效 Content-Type。
- 错误内容已超过原 64 KiB 上限、已确定按原语义返回 null 的 reader 清理，保留原取消 reason 并释放 reader lock。

原 HTTP 状态、Retry-After、分类、Kernel 重试预算和流式 idle 超时不变。调用者取消仍优先于已知 HTTP 错误；原私有记账仍等待真实写入完成，其失败仍优先，不能异步丢弃。没有把 HTTP 错误作为模型成功，也没有新增采样、GET 恢复或业务入口。

本轮取消请求不等待 cleanup 返回，不承诺不配合的底层 source 已结束。测试中的永久 pending cancel、tee 等清理实现不能成为错误交付的先决条件；实际连接资源的关闭仍由原 fetch/stream 实现负责。

## 真实适配器负例

修改前先运行完整 Responses 回归，283/283 通过。新增负例使用真实 DirectResponsesTransport 和 CrewONAgentKernel，依赖注入的 fetch 返回原生 Response/ReadableStream，source 的 cancel 永久 pending，不打开外部连接、不缩短或触发 idle 超时。

首轮 11 项测试中 10 项失败，原因都是 `known failure waited for cleanup`；cleanup 异步拒绝的原分类用例已通过。生产改动后，该 11 项全部通过，并补充 GET 的 401/404/429 分类覆盖。超 cap 分支另外先运行原 `await reader.cancel` 的 400/429 和用户取消负例，3/3 失败，改动后 3/3 通过。最终专项共 17 项：永久拒绝单次 POST、暂时拒绝原三次 POST/两次 retry 与 Retry-After、GET 原分类、无效 Content-Type、调用者取消、最终记账失败、cleanup 拒绝无 unhandled rejection、超 cap 原 null 分类与 reader lock 释放。

旧专项中仅为“等待 cancel 导致 idle”设计的 401/403/422/503 用例由上述真实永久 pending cancel 用例替代。400/404 和 429 的 body-read idle 原行为回归保留。

最终在 Node 24 执行：Responses 完整回归 296/296、Kernel 完整回归 62/62、Responses typecheck、TypeScript boundary、`pnpm format` 与本轮文件 Prettier 检查均通过。

## 尚未关闭的读取问题

POST 400/404/429 仍使用 `readBoundedErrorBody`，未超过原 byte cap 的合法、部分和空内容仍等待完整响应 EOF；挂起时仍等原 idle deadline 一次。本轮没有改变这些读取与分类路径，因为它们承担 previous_response 精确拒绝恢复、context/cyber 分类及 429 usage-limit 判断。只在已确定超 cap、原本就返回 null 的分支解除取消 promise 的等待。

下一步需要把 HTTP 的确定失败、可选诊断内容和清理分别建模。不能从 JSON 前缀、自由文本或缺失内容猜测 previous_response 拒绝，也不能把未知 429 当作已确认 usage-limit。立即结束与接收任意迟到的完整 body 分类不能同时保证；诊断读取的独立生命周期与回退政策需要单独明确并覆盖行为兼容。

核对的 [Codex 官方 HTTP transport](https://github.com/openai/codex/blob/main/codex-rs/http-client/src/transport.rs) 会保留 HTTP 状态与 Retry-After，但错误内容读取仍在返回 HTTP error 前等待。它提供分类参考，不证明错误内容已零等待。

本轮是本地源码与协议边界验收，未更新 Web 或桌面，也未访问模型网关。没有证明最早 557 秒执行慢、Lite 首次断流属于网关、渠道或 Cloudflare；相关原证据仍见 [HTTP 拒绝重试记录](./model-http-rejection-retry.md)。
