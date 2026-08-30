# ADR-001：Provider Contract 所有权与分发

状态：接受

## 决策

Provider wire contract 由提供方 Agent Platform 单一拥有。CrewON 不维护第二份手写 schema，只 vendoring 一个带 provenance 和 digest 的生成产物，用于离线 Rust 构建与测试。

## 原因

- 把 canonical 放在消费方会让提供方实现依赖消费方仓库，职责倒置。
- 新建共享仓、包注册表或 Contract Broker 对 Wave 0 是过度设计，也引入发布和凭据基础设施。
- 运行时或测试时从网络下载不 hermetic，且会让历史 revision 无法复现。
- 生成产物 + digest 是当前两个独立仓库下最小的可审计分发方式；唯一可编辑源仍在 Agent Platform。

## 约束

- CrewON distribution 文件头无法写注释，因此用 sidecar 标记 generated 状态和 source digest。
- 更新流程必须先修改 Agent Platform canonical，再同步 distribution 和 digest，最后运行双方 contract test 与跨仓 compare。
- 任一仓不得单独接受只改 distribution 或只改本地模型、却不更新 canonical 的变更。

## 后续演进

当 Provider Contract 有第二个独立提供方或发布频率显著提高时，再评估独立 versioned package/registry；在此之前不建设 Contract Broker。
