# HTTP 拒绝不能因错误内容挂起而重新生成

2026-10-11，修复提交 `8b7da48ed`。

已复现的本地错误是：收到 HTTP 400 等明确拒绝后，读取错误内容时触发原空闲超时；catch 用超时覆盖已分类的不可重试拒绝，Kernel 随后重复发送整轮 POST。纯 fetch/计时器回归中，原实现实际发送三次、重试两次；修复后发送一次、零重试。

修复仅调整 POST 错误分类优先级，保留取消和私有控制/记账失败的优先级。400、401、403、404、422 的拒绝不会被错误内容超时变成可重试；408、409、429、5xx 和尚未收到响应头的网络中断仍使用原策略。没有修改超时或重试次数，没有开启 GET，没有把部分输出或无终态流当作完成。

Responses 全包 283/283、类型检查通过，新增 15 个回归覆盖实际 Kernel POST 计数、取消、私有记账失败、未知响应头与暂时性拒绝。Kernel 全包 62/62 另行通过。这些不是整仓测试总数。

真实 Web UI→Control→Worker→本机可控 HTTP 服务已验收：明确标记的故障注入返回 HTTP 400，但错误内容挂起；使用原 60 秒空闲超时，Run 在 60.980 秒后以 `responses_request_rejected` 失败，实际服务与私有账本均为一次 POST、零 retry，没有成功助手消息。原 admin 登录保留。本机测试未调用外部模型，不能代替真实网关验收。证据见[Web 拒绝回执](../output/plugin-foundation/gateway-root-cause-20261011/01a12b1c-77f7-7049-b817-bffec0b56acb.web-receipt.json)与[实际 HTTP 服务记录](../output/plugin-foundation/gateway-root-cause-20261011/web-http-rejection-fixture.json)。

随后关闭本机故障服务，恢复实际 `api.aicuican.com` 网关和原 API Key。原 Web 登录保持，同一会话顺序使用 `gpt-6.1-sol` 和 `gpt-6-astra`，分别在 13.936 秒和 4.012 秒完成；首段分别为 3.081 秒和 3.439 秒，各一次调用、零 retry、一个最终助手消息，均收到显式协议终态。这不是并行测试，也没有在真实网关复现 HTTP 400 错误内容挂起。证据见 [GPT-6.1 回执](../output/plugin-foundation/gateway-root-cause-20261011/01a12b1f-9f91-7748-a894-da5a4d0836bf.web-receipt.json)、[GPT-6 回执](../output/plugin-foundation/gateway-root-cause-20261011/01a12b20-88ee-7098-b496-2a84d2ed4dfb.web-receipt.json)和[当次 Web 界面](../output/plugin-foundation/gateway-root-cause-20261011/web-http-rejection-fix-proof.png)。

Web 放行后才将正式 `/Applications/CrewON.app` 更新为 `0.1.70`。候选保留已核验 `0.1.69` 的生产闭包，只同步上述 transport 修复与 UI 包版本；五个已发行 Native 宿主源逐字保持，未带入新插件目录/状态接线或其他 WIP。候选与正式 ASAR、八个运行时文件一致。原 admin 与 `CrewON图片验收` 会话恢复，真实 `gpt-6.1-sol` 在 7.504 秒完成短回复，首段 5.884 秒、一次调用、零 retry。正常退出重开后，原账号、旧 40 行产物、新回复和模型选择均恢复；同一 Run 的更新时间与一次调用计数不变，未重新生成。业务插件仍为 0。本轮没有重复桌面长输出、并行或所有模型测试。证据见[候选核验](../output/plugin-foundation/gateway-root-cause-20261011/candidate-0.1.70-verification.json)、[正式核验](../output/plugin-foundation/gateway-root-cause-20261011/installed-0.1.70-verification.json)、[模型回执](../output/plugin-foundation/gateway-root-cause-20261011/desktop-0.1.70-model-receipt.json)与[冷恢复验收](../output/plugin-foundation/gateway-root-cause-20261011/desktop-0.1.70-acceptance.json)。

此修复消除了确定的重试放大路径，但错误内容挂起仍等待一次原空闲超时。它不是此前 557 秒 Lite 运行首次断流的根因证据，不能据此把历史故障归因到网关、渠道或 Cloudflare；相关历史与请求/终态兼容修复见[当前基础建设状态](./plugin-foundation-status-20261011.md)。
