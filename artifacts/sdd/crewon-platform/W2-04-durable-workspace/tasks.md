# W2-04DW Tasks

- [x] D1 证明 CredentialOwner 已随 authenticated principal 跨连接稳定。
- [x] D2 证明 workspaceKey 仍为 session random，阻断 durable Provider/Task recovery。
- [x] D3 冻结最小 root identity mapping；不持久化 path、scope binding 或权限快照。
- [x] A1 建立 State Red Harness。
- [x] A2 添加 migration 与 strict record/validation。
- [x] A3 实现 create-or-resolve、exact read、reopen/concurrency/tamper/capacity Harness。
- [x] V1 运行 `just test -p crewon-state durable_workspace`、全包、scoped fix 与最终 fmt。
- [x] B1 实现 authenticated-only app-server adapter；connection-scoped 路径保持原语义。
- [x] B2 覆盖并发 refresh、State/app-server reopen、catalog removal 与 path-free projection Harness。
- [x] V2 完成 app-server targeted/full regression、既有 Office flaky 隔离复跑、scoped fix 与最终 fmt。
- [x] V3a 恢复 W2-04 projection/resource DTO；client-selected Credential processor 经后续 review 撤回，production Gate 保持关闭。
- [x] V3b 完成默认关闭的 production descriptor factory/config kernel A2b。
- [ ] V3c 完成 startup composition、RPC 与 Resource API A2c/A1b/A3。
