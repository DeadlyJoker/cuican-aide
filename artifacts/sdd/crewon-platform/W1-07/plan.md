# W1-07 Implementation Plan

## Stage A: Typed Fragment

1. 在 `core/context/governed_context.rs` 定义闭集 metadata、bounded spec、fragment 和 bundle。
2. fragment 实现 `ContextualUserFragment`；预算在进入模型输入前完成。
3. sibling unit tests 覆盖全部 fail-closed 规则。

## Stage B: Server-derived Adapter

1. 在 app-server `platform_control/context_adapter.rs` 显式映射 RequestIdentity + WorkspaceRef + consumer kind。
2. 不注册 RPC/processor，不读取 cwd/Office JSON，不增加 fallback。
3. unit tests 覆盖 scope mismatch、member private 和相同 path 语义下 binding identity 隔离。

## Stage C: Outbound Harness

1. 新增独立 core suite integration test，使用 `core_test_support::responses` 捕获真实 request。
2. 验证 trusted/untrusted roles、Tool/Provider 无法升级、超限已截断。
3. 连续 Turn 比较 input，证明相同 fragment 只出现一次且顺序稳定。
4. Single/Experts/Office 使用不同 bundle/request，证明不会混入其他 audience 内容。

## Verification

1. `just test -p crewon-core governed_context` 与目标 core suite test。
2. app-server context adapter targeted test。
3. `just fix -p crewon-core`、`just fix -p crewon-app-server`，最后 `just fmt`；之后不重跑测试。
4. 不运行完整 workspace `just test`，除非用户明确批准。
