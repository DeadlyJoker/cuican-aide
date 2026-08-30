# W2-04IS Plan

## Stage A: Contract（已完成）

1. 审计 `cuican-api`、Agent Platform auth/WeCom/UserExternalIdentity 与 Permission Service membership。
2. 决定 Agent Platform 是唯一 binding authority；`cuican-api` 不是 target authority。
3. 用 exact resolve/read + 60 秒 freshness 替代全局 snapshot/mutation feed。
4. 冻结 canonical JSON、binding digest、stable actor known vector 和双端 strict parser。

## Stage B: Agent Platform authority kernel（已完成）

1. Red Harness：binding model/repository/application 不存在。
2. 新增 immutable target、active uniqueness、terminal revoke、source revision 与 digest。
3. resolve 前调用 Permission Service 验证 user/tenant/space active membership。
4. exact read 每次重验 membership；失效则同事务 revoke。
5. 不注册 HTTP，不签 principal token，先通过 create/revoke/rejoin/restart/concurrency Harness。

## Stage C: Source API + CrewON refresh adapter（已完成）

1. 增加独立 service credential audience/scope 与 bootstrap principal assertion verifier；首次 assertion 不含尚不存在的 binding id。
2. 注册 exact resolve/read API；read 必须提交 sourceBindingId + expected local owner tuple，无 list/enumeration。
3. CrewON adapter 将 fresh active snapshot CAS 到 P2b-1 local mapping，将 revoked snapshot terminal revoke。
4. restart 前 bounded refresh 所有 active local mapping；任一 freshness 丢失则相关 authority fail-closed。

## Stage D: Principal session + revoke production composition

1. [x] Agent Platform 在 fresh active binding 之上实现独立 RS256 CrewON principal session issuer；不得复用 bootstrap assertion。
2. [x] Agent Platform durable session registry 与 gap-free JTI revoke stream kernel：exact/binding revoke、bounded watermark snapshot/read、restart 与 compaction cursor Gate。
3. [x] 冻结并实现 session-issue/revocation HTTP contract；service scope、bootstrap assertion、body authority 与响应 bounds 分离。
4. [x] WebSocket verifier 支持受信 RS256 keyset，并把 actorId、binding id/revision作为 server-owned principal metadata。
5. [x] CrewON listener 启动前加载 authoritative snapshot 并立即 catch-up，以 1 秒间隔、5 秒 source deadline 维护 gap-free cursor；stream/cursor/freshness 丢失永久 fail-closed。
6. [x] 注册两端默认关闭的受监督 production composition；Agent Platform logout/context switch 接入原子 session revoke，membership-loss read/revoke 与 session revoke 同事务。
7. [x] 实现用户 bootstrap issuer、CrewON `/principal-session/exchange` 与 in-process access-token → bootstrap → resolve → session → logout revoke Harness。
8. [x] 前端接入 bootstrap/exchange/reconnect；浏览器用固定 WebSocket subprotocol 携带内存态 session JWT，非浏览器继续使用 Authorization header，token 不进入 URL/storage。
9. [x] 在 Agent Platform auth 建立 bounded durable auth-session family + monotonic epoch + server expiry；access/refresh 保持同一 family，refresh/context switch 滑动续期并回收过期 slot，bootstrap/session expiry 钳制到 family expiry，session issue 同事务重验，覆盖旧 access/refresh replay 与 bootstrap-before-logout race。
10. [ ] 配置生产 keyset/service credential 并完成轮换验收；隔离跨服务 logout/context switch/member removal/restart smoke 已通过。
11. [x] 使用隔离真实 RSA key、Permission、MinIO、加密模型凭据完成 Provider v3 discovery/start/read/events/output live smoke。
12. [x] 完成隔离运行中 cancel、worker crash/restart、unknownOutcome 与 at-most-once replay 故障演练。
13. [ ] 完成生产 keyset 轮换、完整配置与真实云模型验收后，才注册 CrewON CloudWorker/Provider production composition并评审是否打开生产 Gate。
