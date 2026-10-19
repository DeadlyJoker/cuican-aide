# 网关心跳破坏 SSE：隔离复现与修复

在干净的 Codex-Manager v0.6.3 源码 `764531421428e35b0fbb3aab8f4f777887e7a44a` 中复现了一项转发缺陷。源码来自 `qxcnm/Codex-Manager`；当前线上通道是否运行这份版本尚未核实，补丁没有部署到生产。

## 根因及真实复现

`OpenAIResponsesPassthroughSseReader` 将收到的原始字节立即转发。每次等待达到心跳间隔时，原实现直接输出 `: keep-alive` 注释和空行，没有判断当前是否在一个 SSE 事件中间。

测试使用真实 Rust reader、原 GatewayByteStream、原 sidecar 解析器和异步通道。先送入一条 response.completed JSON 的前半部分，等待 55ms，再送剩余部分；测试心跳设为 10ms，以确定性触发多个周期，不改变生产默认设置。上游 sidecar 看到了完整终态，但原 reader 交给客户端的字节在 JSON 逗号后插入了多条心跳，断言失败。此前字节由实际失败日志的数字数组恢复，全部是具名测试数据，不含用户响应。

这些注释无法在 JSON 字段中间保持 SSE/JSON 的含义。[SSE 标准](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream) 规定事件由空行分隔，注释必须作为独立行出现，行结束可为 CR、LF 或 CRLF。不能拿一段 TCP/HTTP 分块的边界当作事件边界。

## 修复

增加恒定内存的字节边界状态，仅在事件之间插入心跳；单行结尾或未完成的多行事件均不能开放这个边界。状态跨分块识别 CR/LF/CRLF，原字节仍立即转发，不缓存整条模型消息。正常静默间隔、首事件前的心跳、关闭和 usage drain 保持原流程。

补丁涉及原 reader、模块注册和一个集中边界模块，没有修改业务数据库、账号、模型、计费、认证、超时或部署配置。`codex-manager-sse-heartbeat-boundary.patch` 已在原始 HEAD 的文件副本上通过 git apply --check，并实际应用后逐文件比较一致。

## 验证范围

- 原实现：真实 Rust 延迟分块测试失败，sidecar 已收到终态但转发字节损坏。
- 修复后：流读取相关 23 项及整个 http_bridge 143 项全部通过；23 项包含于 143 项，不相加计数。桥接检查包含 streaming/non-streaming、Responses、Chat Completions、tool_calls 和原有心跳行为。
- 将实际 Rust 输出交给 CrewON 的原 SSE 解析器，修复前命中 responses_event_json_invalid，修复后得到一条完整 response.completed。
- 将修复后字节通过真实本地 HTTP 交给原 DirectResponsesTransport，保留严格序号/身份检查，并保持 HTTP 连接开启。客户端在约 19.105ms 内收到一次完成事件，未等待 EOF 或闲置超时。HTTP 的 created 头帧是显式具名 fixture；不是实际模型请求，也不是业务 Run 验收。
- 后续固定字节 fixture 补入 sequence_number=1 供严格客户端检查；原失败日志里的 JSON fixture 未带序号。两者都是 synthetic 数据，不能把其长度差直接当作生产网络丢字节量。

证据：`gateway-heartbeat-before-fix.log`、`gateway-heartbeat-after-fix.log`、`gateway-http-bridge-regressions.log`、`gateway-crewon-wire-verification.json`、两份 named SSE 字节文件及 `verify-gateway-sse-bytes.mjs`。首次离线 Cargo 构建因缺少已锁定的 Git 依赖缓存不能执行；随后联网拉取同一锁定依赖，在任务私有 DB/target 下完成编译。Cargo.lock 未改，测试没有向真实模型、媒体或生产数据库发送请求。

## 线上责任边界的新核验

当前公网 GET / 返回标题“璀璨API”；GET /api/status 返回版本 `v1.0.0-rc.8-27-g12deba956-portal.1`、同名 system_name 和 success=true，分别约 2.604s、1.930s。均未携带 token，只读取有限公开元数据。[New API 官方路由](https://github.com/QuantumNous/new-api/blob/main/router/api-router.go) 的 /api/status 为公开状态接口。

这证明当前公开状态与 New API 风格入口一致，不能依据旧部署记录直接把整个 api.aicuican.com 当作 Codex-Manager v0.6.3。仍需核对 /v1/responses 的实际路由、codex-plus 通道上游以及两段发送日志，再决定补丁应落在哪个组件。公开状态不证明后台上游拓扑、源码版本或已发生的流截断根因。

真实大纲 Run 的两次 idle 记录没有完整终态，尾部 JSON 不完整或损坏；尚未捕获线上原始发送字节，不能将这两次直接归因于本次心跳缺陷。TLS 的间歇等待也仍是独立问题，SSE 修复不能解释响应头前的延迟。

实际《重录》只读复核仍为 Foundation3/parameters2、文字 artifact0、最近任务 canceled/19。没有重新提交创作、生成或上传，桌面包及 profile 未改。线上定位、完整客户端验收、剧本/视频制作、真实 AI 审核返修与商业质量验收仍未完成。
