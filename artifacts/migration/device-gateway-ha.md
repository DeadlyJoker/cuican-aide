# Device Gateway HA 最终态与当前证据

日期：2026-08-09  
状态：In progress

## 最终态不变量

多 Gateway 不能只共享一张 execution 表。最终态由两个相互独立但同时生效的 fencing authority 组成：

1. `device_dispatch_records` 是 execution authority。相同 `executionId` 只能形成一个 stable action fingerprint、一个原始
   command 和一个不可漂移的 terminal receipt；续租 command 只能命中同一 fingerprint，不能覆盖原始副作用身份。
2. `device_connection_routes` 是 connection authority。每次通过独立 mTLS 身份校验的 Device 连接都会为该 Device 原子提升
   connection epoch；`gatewayId + connectionId + epoch` 是唯一可续租和释放的 route fence。旧 Gateway 不能续租、删除或接管
   新 epoch。
3. Worker 请求先读取 active route。owner 是本机时必须再次核对 route fence 与本机 Session；owner 是其他 Gateway 时只能通过
   预配置、双向认证的 peer transport 转发，并把读取到的完整 route fence 一起发送。目标 Gateway 在 Device dispatch 前再次
   读取 authority；route 已变化必须返回 retryable stale，不得转发第二次或 silent fallback。
4. PostgreSQL 连接失败、route 不可证明、peer 不可达均 fail closed。不得因为本机恰好存在旧 WebSocket 就绕过共享 route。
5. Gateway route epoch 必须最终到达 Device execution boundary。Native Device 需要持久化已见最高 epoch，并拒绝旧连接上的
   command；否则数据库可以 fence Gateway 写入，却无法完全关闭“旧 Gateway 校验后、Device takeover 前后”的网络竞态。

## 当前已落地

- Standalone SQLite 与 Team PostgreSQL 通过同一个异步 `DeviceDispatchStorePort`；Server 在 listen 前等待 authority migration，
  配置缺失或 SQLite/PostgreSQL 双配会直接失败，不做 fallback。
- PostgreSQL schema v2 使用 advisory transaction lock 串行化 migration，保存 immutable prepared command 和 terminal
  resolution；Server 在 bind 前拒绝高于当前实现的 schema。两个独立 Pool 同时 prepare 时严格得到
  `created + existing`，初始 Device send 只有一次。
- 两个独立 Pool 同时提交不同 terminal 时只允许一个成功，另一个得到 `device_dispatch_terminal_conflict`，已提交 receipt 不变。
- PostgreSQL connection route claim 原子增加 epoch；旧 epoch 的 renew/release 均失败，过期 route 不参与路由。
- Gateway heartbeat 无法续租或发现更高 epoch 时主动关闭旧 Session；新认证连接可在另一 Gateway 接管，旧 Gateway 的关闭不会
  删除新 route。
- `DeviceGatewayDispatchRouter` 按 route owner 选择 local/peer，并在目标侧再次核对完整 fence。本地没有 peer transport 时，远端
  owner 返回 retryable `device_gateway_peer_unavailable`，不会误用本机 Store 或旧 Session。
- Team production entrypoint 已接真实 Gateway peer transport：Gateway 使用与 Device/Worker 分离的 registry role 和 client
  certificate，静态 endpoint 只接受 HTTPS origin；内部 contract 有严格字段和大小上限，携带 source Gateway identity 与完整
  route fence。目标 Gateway 先把 mTLS certificate 映射为已注册 Gateway，再核对 payload 中的 source ID，并直接调用
  `dispatchExpected`，不会递归路由或形成多跳循环。
- 真实 TLS 1.3/mTLS 网络测试已覆盖 Worker 命中非 owner Gateway、peer 转发到 owner、owner 再向真实 WebSocket Device 发送并返回
  terminal receipt；同一路径也在两个独立 Pool 共享一个隔离 PostgreSQL 15 schema 时通过。伪造 payload source Gateway 会在
  dispatch 前拒绝。
- Device Protocol 已增加 strict `crewon.device-welcome.v0`：Gateway 在 route claim 后、Session 对外可用前发送
  `deviceId + gatewayId + connectionId + connectionEpoch + leaseExpiresAt`。TS 与 Rust parser 消费同一 valid/invalid fixture；网络
  Device simulator 在收到 welcome 前不接受 command。
- 新的最小 Rust `crewon-device` crate 已实现 Native connection-epoch fence：更高 epoch 以 append-only record 原子落盘并
  `fsync` 后才返回 accepted；重启重读最高 epoch，replay/rollback、过期 lease、错 Device 和损坏状态均 fail closed。初始 route
  lease 只在接受 welcome 时校验，后续命令不错误依赖最初 30 秒 expiry（Gateway 在数据库内独立续租 route）。
- `NativeDeviceConnection` 已把 bounded raw welcome/command JSON、shared strict parser、最多 32 个轮换 Ed25519 PEM public key、
  signature/expiry 和 epoch permit 收敛为一个执行 admission。Capability 可先检查 `VerifiedDeviceCommand`；真正 start 前再次验时间并
  获取 permit，所以“旧 socket 已验签、随后 takeover、最后才尝试 start”的窗口也会拒绝且副作用计数为 0。Cargo focused
  `10/10` 通过。
- 本机隔离 PostgreSQL 15 故障注入会启动两个独立 Node Gateway 子进程：Worker 命中 non-owner，owner 在收到 Device
  `execution.accepted` 并 ACK 后被真实 `SIGKILL`；测试通过数据库时间条件的显式 SQL 推进 route expiry，再让另一 Gateway claim
  新 epoch。reconcile 与 cancel 都 attach 原 execution，初始副作用启动计数严格为 1。完整 Device Gateway PostgreSQL 矩阵
  `46/46`，该强杀用例另连续执行 3 次均通过且无遗留子进程。

## 尚未完成，禁止声明 HA

- Native raw admission 尚未接入真实 WSS/UDS sidecar、process/PTY/filesystem capability dispatcher 和 durable receipt；当前 Rust
  library 与 WebSocket simulator 证据不能替代三平台 Native execution boundary。
- Gateway 强杀用例使用本机子进程、test TLS identity、fake Gateway-side command authorizer 和确定性 SQL expiry，不证明 production
  registry/CA、真实 30 秒租约等待、Native sidecar 或跨主机故障恢复。
- PostgreSQL 备份恢复、网络分区、staging SLO 和 route retention/observability 尚无证据。

因此当前结论是：共享 execution/route authority、跨 Gateway mTLS 单跳 dispatch、connection-epoch wire、Native raw admission
组件和本机多进程强杀恢复证据已落地；真实 Native sidecar、三平台和 production chaos 完成前，仍然不能声明完整生产 HA。
