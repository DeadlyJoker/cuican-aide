# W0-01 实施计划

## 文件

- <code>codex-rs/app-server-protocol/src/protocol/v2/platform_contract.rs</code>
- <code>codex-rs/app-server-protocol/src/protocol/v2/platform_contract_tests.rs</code>
- <code>codex-rs/app-server-protocol/src/protocol/v2/mod.rs</code>
- <code>codex-rs/app-server-protocol/src/export.rs</code>
- <code>codex-rs/app-server-protocol/src/schema_fixtures.rs</code>
- <code>codex-rs/app-server-protocol/schema/canonical/platform_contract.v1.json</code>
- schema generator 产生的 TypeScript/JSON 文件

## 顺序

1. 增加测试模块和 canonical JSON 示例，使编译/fixture 测试先失败。
2. 实现纯 DTO/enum，不增加 RPC。
3. 将根 fixture 类型接入现有 TS/JSON schema generator。
4. 运行 schema generator，审查新增文件和 index。
5. 运行 protocol targeted tests。
6. 检查 ClientRequest breaking surface、v1、CLI、config、rollout resume 均无变化。
7. scoped fix，最后 just fmt；之后不再运行测试。

## 变更规模

- 非机械 Rust 逻辑目标低于 500 行。
- schema 生成文件属于机械变更，可超过 800 行，但必须只包含新增 canonical 类型。
- 若 generator 产生无关大面积漂移，停止并先修生成环境，不提交噪音。

## 回滚

该切片没有生产 RPC 或状态。若契约评审不通过，可删除新增类型和生成文件，不影响旧 API。
