# W3-02LKR Tasks

## Discovery

- [x] D1 盘点本地 `knowledge/list`、Provider KnowledgeBase、Connector 和 UI 调用链。
- [x] D2 对照 W1-07、W2-04、W2-05，确认不建立第二套 Provider Router。
- [x] D3 确认当前并行改动边界，冻结 A1 叶子文件范围。

## A：本地基线

- [x] A1 为显式工作区知识写入增加字段和文件大小硬上限。
- [x] A2 使用已有原子写工具，避免部分文件。
- [x] A3 增加重复写、超限拒绝和失败不落盘测试。
- [x] A4 完成 targeted test、`just fix -p crewon-app-server` 和 `just fmt`。

## B：Source Catalog

- [ ] B1 为 KnowledgeSource 增加 `localWorkspace/providerKnowledgeBase` origin。
- [ ] B2 从 canonical Provider Resource Binding 投影已授权 KnowledgeBase。
- [ ] B3 UI 展示本地/云端、授权、新鲜度与错误状态。
- [ ] B4 保留旧客户端兼容并更新 schema、README 和集成测试。

## C：Governed Retrieval

- [ ] C1 定义 read-only Knowledge retrieval port 与有界查询结果。
- [ ] C2 实现本地 lexical/FTS adapter。
- [ ] C3 复用 W2-05 Provider `search` adapter。
- [ ] C4 映射到 W1-07 `GovernedContextFragment` 和服务端 citation manifest。
- [ ] C5 覆盖 workspace/principal/revoke/revision/freshness/预算 Harness。

## D：产品与迁移

- [ ] D1 将 Knowledge UI 收敛为知识源中心。
- [ ] D2 将 `.crewon/knowledge.md` 定位为显式本地笔记源。
- [ ] D3 移除 Knowledge、个人 Memory、Office Memory 的混合文案和重置入口。
- [ ] D4 为跨域提升增加显式预览、审批、审计和撤销。

## Verification

- [x] V1 更新 `verification.md` 的命令、结果和未完成 Gate。
- [ ] V2 完整 workspace `just test` 仅在用户批准后运行。
