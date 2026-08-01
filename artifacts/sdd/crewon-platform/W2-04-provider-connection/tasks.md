# W2-04PC Tasks

- [x] D1 识别投影型 Ref 被误用为 connect Params 的 authority 漏洞。
- [x] D2 识别内存-only connection 无法满足 process restart recovery。
- [x] D3 冻结最小 immutable connection record；不保存 Secret/endpoint/capability/workspace。
- [x] A1 建立 State Red Harness。
- [x] A2 添加 migration 与 strict record/validation。
- [x] A3 实现 create-or-resolve、read、reopen/concurrency/tamper/capacity Harness。
- [x] V1 运行 targeted/full state tests、scoped fix 与 final fmt。
- [x] V2a 恢复 authority-free Provider projection/Resource DTO 与直接 schema/TS Harness；client-selected selection DTO 已撤回。
- [x] V2b 实现并 review prototype connect/read processor；确认 production provisioning 缺失后撤回，不作为 production 完成项。
- [x] V2c 实现默认关闭的 production Agent Platform factory/config kernel；复用 W2-03 endpoint guard、strict descriptor 与共享 RS256 signing key，真实 descriptor Harness 通过。
- [x] V2d 完成 Provider Access Grant prerequisite、重建 processor，并完成 app-server 启动组合、restart/config-removal/readiness Harness；该阶段未提前注册真实路由。
- [x] V2e 注册 provider/connect/read 路由并生成方法级 schema；Resource API 另做独立切片。
- [x] V2f 复用 connection authority 实现 live catalog resource/list/read，并注册独立 experimental wire；durable Resource Binding 继续后置。
