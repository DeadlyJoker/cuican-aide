# New API 结束事件与读取生命周期：隔离复现修复

本轮用实际 Go 转发器和真实本地上游 HTTP 复现了两处结束处理缺陷，保留完整 usage 与原终态字节。修复仅在隔离源码中，没有部署到线上，也没有重新提交《重录》的模型、生成或上传请求。

## 源码身份和证据边界

源码来自 QuantumNous/new-api 的公开 `v1.0.0-rc.8`，确切提交 `b9bc6f0e21fb3b87267475912fc7c31fa0494d6e`。当前公开入口返回的是 `v1.0.0-rc.8-27-g12deba956-portal.1`；`12deba956` 未在本次抓取的公开仓库历史中解析成功。不能把公开基线当成线上私有构建的确切源码，不能据此确认线上两次不完整 JSON 的原因或部署补丁。

依据的是实际读入的 [Responses 转发源码](https://github.com/QuantumNous/new-api/blob/b9bc6f0e21fb3b87267475912fc7c31fa0494d6e/relay/channel/openai/relay_responses.go) 和 [扫描器源码](https://github.com/QuantumNous/new-api/blob/b9bc6f0e21fb3b87267475912fc7c31fa0494d6e/relay/helper/stream_scanner.go)。这是既有网关的隔离诊断，不是在 CrewON 中增加另一套 runtime、生成服务或业务数据库。

## 分阶段复现

具名测试上游通过真实 HTTP 发送 `response.created` 和合法 `response.completed`，然后保持连接开启，不发送 `[DONE]`。实际 `OaiResponsesStreamHandler` 和 `OaiResponsesToChatStreamHandler` 分别读取该 HTTP 响应，输出到原 Gin Writer。

1. 原代码已经转发终态、读取 usage，却没有调用 `StreamResult.Done()`。两条路径在一秒观察截止时仍未返回；测试主动关闭具名上游后才结束。这一秒是测试截止，不是测出的生产超时时间。
2. 仅补 `Done()` 后，状态已经为 done，但仍未在一秒内返回。扫描线程阻塞于上游 `Read`，原清理先等线程，再关闭响应体，存在错误的释放顺序；原清理的兜底等待是五秒。
3. 补齐读取生命周期后，两条路径约 0.64ms 和 0.16ms 返回，真实上游连接关闭，usage 仍为输入1/输出2/合计3。后续最终回归仍通过这些断言；这些延迟是本机具名测试数据，不能套用到生产网络。

## 修复范围

- 两条 Responses completed 分支在原终态输出和 usage 处理后通知扫描器正常完成。
- 原扫描器清理先取消自己的 context 并关闭实际响应体，使阻塞读取退出，再 join 原线程；不新增执行循环、重试或旁路发送。
- 清理主动关闭响应体产生的读取错误不再记录成新的扫描错误。真正未取消的读取错误保留原处理。
- 普通 `response.output_item.done` 仍不能完成整轮响应。实际 HTTP 客户端取消仍归因于 client_gone，并关闭上游；不伪造成功或完整作品。

没有修改账号、计费公式、数据库、认证、渠道或生产配置。补丁 `new-api-responses-terminal-lifetime.patch` 已在该公开提交的原始文件副本上通过 `git apply --check`，实际应用后四个文件字节与隔离实现一致。

## 回归与尚未解决的基线失败

完整执行 `go test ./relay/helper ./relay/channel/openai`：29个顶层测试通过，1个顶层测试失败；另有两个终态路径子测试通过，不能把父测试和子测试相加当作独立案例总数。

唯一失败为原 `TestStreamScannerHandler_StreamStatus_PreInitialized`：它要求预置 errorCount 保留1，而原扫描器入口无条件创建新 StreamStatus，使实际为0。还原公开提交的原扫描器后单独复测，同样失败；随后已恢复本轮修复源码。没有删测、改断言或把整套回归标成通过。该上游基线缺口仍须结合线上确切版本处理。

将实际 Go 转发器捕获的327字节交给 CrewON 原 SSE 解析器，得到一次 created 和一次 completed；再经真实本地 HTTP 与原严格 DirectResponsesTransport，连接保持开启时约18.201ms完成，未等待 EOF。只有具名协议数据，没有真实模型视觉判断、业务 Run 或客户端 UI 验收。

日志保存在 `/private/tmp/crewon-plugin-performance-20261015/`：`new-api-terminal-before-fix.log`、`new-api-terminal-handler-only.log`、`new-api-terminal-after-fix.log`、`new-api-stream-regressions-final.jsonl`、`new-api-preinitialized-baseline.log`。最终测试事件和源码摘要见 `new-api-terminal-lifetime-acceptance.json`；客户端字节检查见 `new-api-crewon-wire-verification.json`。

## 真实项目仍待完成

当前只读 SQL 仍是已确认方案2、Foundation3/parameters2、文字 artifact0、最近大纲 Run canceled/19。Mac 仍锁定，没有执行 UI 操作；实际桌面包、审批文件和 profile 未改。线上终态交付责任、完整大纲/剧本、真实视频声音制作、主动审片返修、播放和商业使用依据均未完成，完整目标继续 active。
