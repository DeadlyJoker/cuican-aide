# Web 插件账号基础

线上 Web 当前使用旧的 standalone Control 与 SQLite 数据集；前端更新不会自动启用生产插件安装。两份已校验候选包是 AI 短剧 50.0.0 和出行助手 0.2.3。上传候选包不等于安装、选择或 UI 挂载。

本轮添加的是显式接入现有 PIM 的账号基础，尚未在公共 Web 开启。

- `PimAccountAuthority` 先验证现有账号，再通过 PIM 重新核验同一租户和空间；不接受浏览器指定另一个身份或空间。可配置真实权限服务，读取当前成员的 `space:read` 判定与角色，避免旧 PIM 列表序列化遗漏角色后产生的只读误判。解码 JWT 只用于读取候选上下文，不能代替上游验证。
- `PostgresWebPluginProfileStore` 在独立、显式迁移的 schema 内持久化账号与插件 profile 的绑定。不同 principal 不共享 profile；身份不可原地改写；权限成员摘要改变或撤权时必须更换 epoch；重新登录不能恢复明确撤销的 profile。构造和读取都不自动迁移。
- `PimControlSessions` 将已验证 PIM 账号交换成最长八分钟的随机 Control 凭据。凭据仅保留在服务端，浏览器只获得 HttpOnly、Secure、SameSite=Strict 的 host cookie 和原来的 CSRF 返回值。Cookie 还必须与当前 PIM 凭据对应，退出或切换账号不能沿用旧账号会话。
- BFF 的 `accountExchange` 是显式 opt-in。启用后，`POST /control-api/session` 必须来自当前 origin、携带原 PIM 凭据且不含身份/业务 body。未启用时仍返回 405，旧 Identity Center 路径不变。Control 代理只收到内部短期凭据，不会收到 PIM bearer。
- Web 客户端只有收到 BFF 自己生成的 `x-crewon-account-exchange: required` 与 `identity_session_required` 时才交换或续期。这个判定发生在转发前，Control 响应不能透传该标记。并发续期合并为一个操作，最多重发一次，保留业务 body 与幂等键并更新 CSRF；普通账号、模型或网络错误不触发反复重试。

## 线上权限服务修复

真实 PIM 账号校验成功，但同一个凭据访问权限服务的空间列表返回 401，最终被 PIM 的上下文接口转换为 503。权限服务使用开发默认签名密钥，与 PIM 的现有密钥不同。

已在服务器对齐现有密钥，没有更换账号凭据。服务器的旧 systemd 不能可靠处理现有多行密钥，使用私有启动配置读取精确字节，再 exec 原权限服务命令。相关配置位于 `/etc/crewon/permission-signing-launch.json`、`/etc/crewon/permission-signing-launcher.py` 和该服务的 `crewon-jwt.conf` drop-in，权限均为 0600；不要复制配置内容到源码、浏览器、构建产物或日志。仅权限服务重启，原 Control 和 Worker 未切换。真实账号、同一空间成员资格及当前 owner 角色均已重新核验。

## 切换前仍需完成

公共 Web 尚未启用新账号 adapter；这份基础提交不声称两个插件已上线安装。生产切换需要连接真实 profile/policy 协议、启用安装与挂载、发布准确的包字节，并完成业务服务组合。现有历史数据必须先在隔离 PostgreSQL 数据集中验证迁移，保留完整会话、团队、工作流、模型状态和幂等凭证；不能把本机 Native 审批或固定 standalone 身份搬到公网。公共切换需有旧配置与数据库回退点。

新增接口和存储默认关闭，现有登录、注册、桌面与 Web 原成功启动路径保持兼容。验收覆盖真实 PostgreSQL 的账号隔离、并发 profile、冷启动读取、角色摘要更新和撤权；BFF 覆盖当前账号绑定、来源/包拒绝、到期、容量、跨 origin 与 body 注入以及未启用模式；UI 覆盖原成功 GET、显式交换、保持幂等性的单次续期和拒绝普通错误重试。真实上游验证与本地命名夹具分别记录，不将夹具当作上线凭证。
