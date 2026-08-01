# W2-03 Verification

状态：W2-02C 与 W2-03A/B/C/D 已完成。`crewon-provider-transport` 是唯一 endpoint/HTTP guard authority，`crewon-provider-agent-platform` 已实现 strict discovery、CatalogProvider 与 durable Run start/read/events/cancel。W2-04、W2-07 已解锁进入 Discovery；其 Discovery 识别出新的必要前置并已暂停实施。W2-08 仍等待 W2-04 至 W2-07，Wave 2 Gate 尚未通过。

## 已确认

- `crewon-resource-federation::CatalogProvider` 只接受 bounded list 与 exact immutable manifest read。
- Agent Platform `/provider/v3` 具备分离 discovery authority、exact AgentVersion list/read 和 durable Run start/read/events/cancel。
- 旧 Open API/CrewON catalog 不能提供 durable exact revision，adapter 没有 one-shot fallback。
- discovery token 与 Run delegation 分离；Run 每次调用都绑定 exact Agent resource、taskId、CredentialId 与 expected Credential revision。
- Endpoint Policy/HTTP Guard 已从 app-server 私有模块迁移为 `crewon-provider-transport` 单一 authority；app-server 中不存在私有 policy/guard 文件、模块声明或兼容 facade。
- production descriptor 当前只声明 `durableRun`、`remoteAgent`、`resumableEvents`，production HTTP application 没有 approval/tool-result mutation route。adapter 因此不暴露伪 mutation API；未声明能力对应事件 fail-closed。

## 本轮实现

- 建立 closed Run authorization operation 与 exact `ResourceRef + taskId + CredentialId + expected revision` binding；Credential 只进入 authorizer/header 最短路径，不进入请求 JSON、Debug 或错误。W2-07 amendment 已同步 Agent Platform claim verifier、authorization digest、Run/Delegation persistence、existing-run ownership 和双方 canonical v3；真实签发端仍待 authenticated principal Gate 后接入。
- 建立 bounded Run domain：start/read/events/cancel、immutable artifact ref、request digest、context task binding、64 KiB input cap、10K prompt cap、32 context refs、事件页 100 项上限。
- 建立 strict Run HTTP wire：command/response/event DTO、closed status/error/event union、unknown field/tag/capability fail-closed、重复 JSON key 检测与 `Content-Type: application/json` 边界。
- 建立 resumable event validation：连续 sequence/cursor、同 run/attempt、单 terminal tail、时间单调、eventId 唯一、output artifact exact task binding。
- 建立无重试 durable client port：descriptor capability preflight 后执行 start/read/events/cancel；429 返回 bounded Retry-After，5xx/timeout/network/unknown outcome 保留显式领域状态。
- canonical Provider Run v3 和 Discovery v1 fixture 继续跨仓字节/哈希校验；approval/tool-result command 仅做保留契约的 strict round-trip，不作为当前生产能力。

## 验证证据

### W2-02C prerequisite

- Agent Platform Provider/W0：210 passed；scoped Ruff 通过；mypy 45 source files 无错误。
- Permission Service registry/batch security：3 passed。
- Provider Run v3 SHA：`e8b07b717ba051b683abee9310ffae45e6d2fe7cecfa7c673c4d48798c63046a`；两仓 fixture 字节相同，hash 变化来自 required `credential.revision` pre-cutover amendment。
- Provider Discovery v1 SHA：`f83f8199a18903e58a25414af97b60c265534ea9a4b1e5b66e5797c598c1b6a6`。

### W2-03A transport

- `just test -p crewon-provider-transport`：7 passed。覆盖 production HTTPS、development loopback、private/link-local/metadata、mixed DNS、redirect rebinding/cross-origin、timeout、response cap 和 path/query injection。
- `just test -p crewon-app-server`：1014 passed，1 skipped；一项既有 Office auto-dispatch 测试由 nextest 重试通过，与 transport 无调用关系。
- `cargo tree -p crewon-provider-transport --depth 1` 无 app-server、core、task-runtime、UI 或 Provider wire 依赖。
- production 模块：endpoint policy 389 LoC、HTTP guard 104 LoC，均低于 500 LoC。

### W2-03B/C adapter

- `just test -p crewon-provider-agent-platform`：31 passed，0 skipped。
- discovery/Catalog 覆盖 strict descriptor、bounded exact list/read、unknown/duplicate capability、manifest identity drift、authorization redaction、429 与无重试。
- Run 覆盖 strict start/read/events/cancel、exact authorization binding、request/body bounds、canonical full-object round-trip、status/identity/timestamp validation、cursor/event ordering、duplicate payload key、malformed/non-JSON response、providerUnavailable/unknownOutcome 与无重试。
- 请求扫描确认 JSON 不包含 workspace root、CredentialId、token 或长期 Secret；Authorization/Delegation header 标记 sensitive，token 使用 `Zeroizing<String>` 且 Debug 固定 `[REDACTED]`。
- `cargo tree -p crewon-provider-agent-platform --depth 1` 的运行依赖仅 transport、resource-federation、reqwest/serde/uuid/zeroize 等通用库；无 app-server、core、task-runtime 或 UI 依赖。
- 事件 HTTP wire 已从 command/response wire 拆为独立私有模块；生产模块最大 486 LoC，全部低于 500 LoC；`git diff --check` 通过。
- `just bazel-lock-update` 与 `just bazel-lock-check` 通过。
- `just fix -p crewon-provider-agent-platform` 无 warning；最终 `just fmt` 通过，之后未重跑测试。

## 未验证与外部阻断

- 未执行真实外部 Provider 网络调用；W2-03 Harness 使用 canonical fixture、可控 resolver 和 mock HTTP。live smoke 保留为独立、凭据注入且可清理的后续验证，不进入默认 hermetic Gate。
- `bazel test //codex-rs/provider-agent-platform:provider-agent-platform-unit-tests` 未进入本 crate 编译：仓库级 `aws-lc-sys 0.41.0` patch 因 `CONTENT_DOES_NOT_MATCH_TARGET` 失败，同时 Apple `CLTools_macOSNMOS_SDK.pkg` 下载返回 403。不得描述为 Bazel test 通过；Bazel lock 本身已通过更新和漂移检查。
- approval/tool-result mutation 没有被“模拟实现”：后端 production descriptor、authorization composition 和 HTTP route 尚未形成完整能力。若未来需要，必须先补后端 capability + 幂等 route + Harness，再通过独立 SDD amendment 扩展 Rust adapter。

## Gate 结论

W2-03 的代码、契约、依赖方向、安全边界和 hermetic Harness 已满足当前任务验收。W2-04（app-server Provider/Resource v2 API）和 W2-07（CloudWorkerExecutor composition）可以并行进入 Discovery，并且必须消费本 adapter port，不得复制 HTTP/auth/SSRF/event mapping。W2-04/W2-07 的后续 Discovery amendment 不回退 W2-03 Gate，但会继续阻止各自实现与 W2-08。production cutover、旧链删除和 Wave 2 Gate 均未发生。
