# W3-02LKR Plan

## 依赖

- W0-01 canonical ResourceRef
- W1-01 RequestIdentity
- W1-02 Workspace Binding
- W1-04 Resource Federation
- W1-07 Typed Context
- W1-08 Policy
- W1-09 Audit
- W2-04 Provider/Resource control plane
- W2-05 Provider Knowledge search
- W2-08 production composition

## 切片

### A1：本地知识文件边界

文件独占范围：

- `codex-rs/app-server/src/request_processors/knowledge_processor.rs`
- `codex-rs/app-server/src/request_processors/knowledge_processor_tests.rs`

增加输入字段和总文件大小硬上限，使用已有原子写工具，补充 targeted tests。不改 wire、UI、中心 processor 或 schema。

### A2：来源契约冻结

只在 SDD 中冻结 `localWorkspace` / `providerKnowledgeBase` 语义。由于当前协议 schema、Platform Control 和 UI 存在并行工作，本切片不修改这些文件。

### B：来源目录

在并行改动合并后，以 additive v2 字段暴露 source origin，并从 canonical Provider binding 投影 Provider KnowledgeBase。不得直接把 connector directory 条目冒充可检索知识源。

### C：统一检索

新增窄的 read-only retrieval port；本地 adapter 负责 bounded lexical/FTS，Provider adapter 复用 W2-05。输出统一构造成 W1-07 fragment，不增加第二套上下文系统。

### D：切流与清理

完成 UI 来源展示、授权状态、citation 和旧文案迁移。切流前需有 hermetic integration tests；Cloud Agent 本地上下文仍保持关闭。

## 变更规模

每个实现切片目标复杂逻辑少于 500 行、总 diff 少于 800 行。协议、后端投影、UI 和切流分别落地，避免单次跨越多个权威边界。
