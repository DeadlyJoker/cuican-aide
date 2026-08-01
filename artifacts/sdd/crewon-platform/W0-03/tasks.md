# W0-03 任务清单

- [x] Discovery：盘点双仓 schema/fixture 能力和当前 one-shot Open API 边界。
- [x] ADR：确定 Agent Platform 单一所有权和 generated distribution。
- [x] Harness Red：双方在 contract type 不存在时失败。
- [x] Harness Red：双方拒绝故意不兼容 fixture。
- [x] Agent Platform：严格 Pydantic contract model 和 mutation tests。
- [x] CrewON：严格 Rust contract model、schema export 和 mutation tests。
- [x] Canonical：固定 fixture、provenance 和 SHA-256；W2-02 production data-plane 修订后以 v3 为唯一 active contract，v1/v2 仅保留历史。
- [x] Gate：双仓分别单命令通过，并完成跨仓字节/digest compare。
- [x] Review：breaking surface、授权不变量、变更规模。
- [x] Verification：记录完整证据并判断 W0-03 是否完成。
