# W0-03 实施计划

1. 固定 canonical ownership、分发和兼容策略。
2. 先建立双端 Harness，证明缺少 contract types 时失败。
3. 实现 Rust/Pydantic 严格模型，但保留一份故意不兼容 fixture，证明双方 fail-closed。
4. 固定 canonical fixture，生成 CrewON distribution 与 provenance digest。
5. 增加 mutation tests 和 event-order/capability/auth invariants。
6. 运行双方目标测试、跨仓 compare、lint、schema generation 和 breaking review。
