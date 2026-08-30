# W1-03 Verification

状态：W1-03 scoped implementation 与 verification 完成；尚未执行需用户批准的完整 workspace test。

## Review stages

| Stage | 范围 | 状态 |
| --- | --- | --- |
| A1 | `crewon-secrets` Credential domain/engine/Fake/Local | 通过；实现文件分别 409/250/119/171 LoC |
| A2 | v2 `CredentialRef` scope/revision + canonical v2 fixture | 通过；schema/TypeScript 已生成 |
| B1 | URL/DNS/IP/redirect policy + Harness | 通过；394 + 214 LoC |
| B2 | DNS-pinned HTTP guard + HTTP Harness | 通过；104 + 131 LoC |
| C | schema、targeted tests、Secret/SSRF review、fix/fmt | 通过 |

## Secret safety matrix

| Surface | Expected | Evidence |
| --- | --- | --- |
| Wire DTO | 只有 CredentialRef，无 owner/Secret | `credential_ref_serializes_only_safe_reference_fields` |
| Debug | Secret 固定 redacted | `secret_debug_and_errors_never_include_secret_value` |
| Serialize | Secret handle 不实现 Serialize；仅 private record 显式暴露给 age 加密路径 | code review + `local_store_round_trips_through_encrypted_secrets_backend` |
| Errors/logs | 错误只接受 static reason；新增模块无 tracing/print | source scan 通过 |
| Local storage | age 密文；密钥在 OS Keyring；同实例操作串行 | ciphertext 原文扫描测试通过 |
| Web | 无浏览器 Secret adapter | `CredentialStore` 仅定义 server-side port，无 UI 变更 |

## SSRF matrix

| Case | Expected | Evidence |
| --- | --- | --- |
| Production HTTPS + public DNS | allow | `production_https_validation_returns_pinned_public_addresses` |
| Production HTTP | deny | `production_rejects_unsafe_url_and_address_classes` |
| Development HTTP + all loopback | allow | `development_http_allows_loopback_but_not_private_networks` |
| loopback/private/link-local/metadata/IPv6 local | deny | unsafe address matrix |
| mixed public/private 或 public/loopback DNS | deny | unsafe address matrix |
| redirect to private | deny | redirect/rebinding Harness |
| same host public -> private re-resolution | deny | redirect/rebinding Harness |
| cross-origin redirect | deny | redirect/rebinding Harness |
| response above cap | deny | `pinned_client_enforces_response_cap_and_timeout_with_http_mock` |
| request above timeout | deny | 同上，真实 HTTP delay |

## Test evidence

- `just test -p crewon-secrets`: 12 passed。
- `just test -p crewon-app-server-protocol`: 237 passed。
- Provider policy/HTTP guard Harness: 9 passed。
- `just test -p crewon-app-server`: 1009 passed，1 skipped；最终回归无 flaky。
- `just write-app-server-schema`: passed。
- `just fix -p crewon-secrets`: passed，无本阶段 warning。
- `just fix -p crewon-app-server-protocol`: passed，无本阶段 warning。
- `just fix -p crewon-app-server`: passed；仅保留 5 条本阶段之前已存在的 Office/Agent Platform lint warning，本阶段新增模块无 warning。
- `just fmt`: passed。
- 完整 Rust workspace `just test` 未执行：本次修改了 protocol，按仓库规则需用户明确批准后才能运行全量套件。

## Secret scan evidence

- 测试 Secret literal 仅存在于 `credential_tests.rs`，未出现在 schema、fixture、snapshot、artifact、UI 或其他实现文件。
- 新实现无 `tracing`、`println!`、`eprintln!` 或 `dbg!`。
- 未修改 UI、localStorage 或 SQLite schema；Credential record 通过现有 `local.age` 密文 backend 持久化。

## Known migration surfaces not cut over in W1-03

- `AgentPlatformRequestProcessor` 仍读取环境变量 Service API Key，并接收旧 access token Params。
- Account Auth 与 MCP OAuth 继续使用各自兼容存储。
- Model Provider、MCP 和 Agent Platform HTTP clients 尚未统一接入 Endpoint Policy。
- `credential/*` 和 `provider/connect` RPC 尚未 composition；由后续 Provider Connection/W1-10 完成。

这些不是 fallback：W1-03 不注册新 Authority，因此当前仍只有旧路径；后续 Gate 通过时必须一次切换并删除 UI Secret 传递路径。
