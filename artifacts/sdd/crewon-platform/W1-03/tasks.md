# W1-03 Tasks

## A. Credential lifecycle

- [x] A1 定义 Credential ID、owner、scope、granted scopes、metadata、status 与上限。
- [x] A2 定义不可序列化且 Debug 脱敏的 Secret handle。
- [x] A3 定义 `CredentialStore` port 和无 Secret 的错误类型。
- [x] A4 实现 Fake store：create/read/inspect/rotate/revoke。
- [x] A5 实现 Local store：复用 `SecretsBackend` 和 OS Keyring-backed local backend。
- [x] A6 添加生命周期、owner mismatch、expiry、limits、corrupt/missing 与 redaction 测试。
- [x] A7 扩展 wire `CredentialRef` scope/revision 和 canonical tests。

## B. Provider Endpoint Policy

- [x] B1 定义 Production/DevelopmentLoopback policy profile 和硬上限。
- [x] B2 定义 resolver port、System resolver 与 Fake resolver Harness。
- [x] B3 校验 scheme、credentials、host、metadata、IP 分类与 mixed DNS。
- [x] B4 校验 same-origin redirect、redirect limit 和每跳重新解析。
- [x] B5 返回 DNS-pinned endpoint 并构造 redirect-disabled/timeout-bounded client。
- [x] B6 添加 bounded body reader。
- [x] B7 覆盖 SSRF、DNS rebinding、response cap、timeout 测试矩阵。

## C. Verification

- [x] C1 `just write-app-server-schema`。
- [x] C2 targeted tests 全部通过。
- [x] C3 Secret 原文扫描无命中；记录允许的变量名/占位值。
- [x] C4 检查无 UI localStorage、SQLite plaintext、URL query、日志或 fixture Secret。
- [x] C5 记录未接入的旧消费者与一次性 cutover Gate。
- [x] C6 `just fix -p crewon-secrets`、`just fix -p crewon-app-server-protocol`、`just fix -p crewon-app-server`，最后 `just fmt`。
