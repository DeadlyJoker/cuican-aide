# W1-10 Verification

状态：W1-10 实现、集成 Gate 与包级验证完成；尚未切换任何生产消费者 Authority。

## Composition matrix

| Case | Expected | Evidence |
| --- | --- | --- |
| forged identity params | protocol reject | real TestAppServer request rejected |
| forged workspace rootPath | protocol reject | real workspace/bind request rejected |
| Single/Office workspace | separate scope and binding | two registry bindings asserted |
| endpoint | validated without network | deterministic public-IP resolver only |
| Resource | exact provider/resource/revision | fake Catalog read + binding asserted |
| Credential | exact owner/status/revision | Credential adapter + store metadata asserted |
| Context | deterministic truncation and hard cap | `was_truncated`, rendered budget and fragment count asserted |
| Approval | exact action digest | request/decide/consume path asserted |
| revoke | old authorization becomes invalid | credential metadata revoked; authorization verify and Policy deny asserted |
| restart | Task/Artifact survive | temporary StateRuntime close/reopen asserted |
| retention | body removed, metadata/audit retained | expiry list + server-derived delete asserted |
| external side effect | none | fake provider/endpoint; no executor or HTTP client used |

## Commands

- `just test -p crewon-app-server wave1_composition_gate`：1 passed，1021 skipped。
- `just test -p crewon-app-server artifact_adapter`：4 passed，1018 skipped。
- `just test -p crewon-app-server policy_adapter`：2 passed，1020 skipped。
- `just test -p crewon-app-server`：1021 passed，1 skipped。
- `./resource-federation/scripts/check-dependency-boundary.sh`：passed。
- `./task-runtime/scripts/check-dependency-boundary.sh`：passed。
- Artifact/Policy source and manifest forbidden-dependency scan：passed。
- `crewon-core` 对 Task/Resource/Policy/Artifact dependency scan：passed。
- `just bazel-lock-update`：passed；仅输出既有 well-known crate annotation warnings。
- `just bazel-lock-check`：passed。
- `just fix -p crewon-app-server`：passed；仅保留 5 个既有 Office/Agent Platform warning，W1-10 没有新增 warning。
- `just fmt`：passed。
- final `git diff --check`、trailing-whitespace、module length 和 production cutover scans：passed。

## Current boundaries

- W1-10 没有注册新 RPC，没有修改中心 request processor，没有切换 Cloud Agent/Office/Workflow/Experts production Authority。
- Wire identity/workspace 伪造验证使用真实 TestAppServer；其余共享底座组合使用服务端派生对象和 hermetic fake ports。
- 新增生产模块分别为 Artifact adapter 358 行、Credential adapter 94 行；均低于 500 行。711 行的 Wave 1 Gate 只包含集成测试。
- Artifact/State 相关生产模块仍全部低于 500 行；`crewon-core` 未反向依赖新领域 crate。
- 按仓库规则，scoped fix/final fmt 后未重跑测试；其后的操作仅为文档和只读静态检查。
- 未运行需要用户单独授权的完整 workspace `just test`。
