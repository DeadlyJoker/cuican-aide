# 项目参考素材的受控字节读取

2026-10-06。已实现宿主内部读取底座，继续服务[短剧阶段执行方案](./short-drama-stage-execution-contract.md)。后续已接受控[源字节冻结](./project-reference-material-freeze-protocol.md)；尚未发布插件UI/Node服务或HTTP入口，供应商目标副本、持久准备回执与媒体Run准入继续实施。

## 来源与授权

`ProjectReferenceMaterialReader` 接收真实调用者及项目/资产/预期head/采用设定/参考修订，捕获原 `ProjectAssetReferenceImageApplicationService` 类方法。它不能用调用者传入的URL、文件名或自报摘要代替实际项目来源。

纯供应商适配器解释已经核验的历史配置及原结果。ComfyUI适配器只接受明确审阅的插件ID、发行版本、manifest/implementation摘要；按原baseUrl及规范化output引用构造确切`/view`路径。它核对原URL、配置与结果身份，拒绝目录穿越、注解、Windows路径和服务替换。适配器产出的路径DTO不授予网络访问。

独立 `ProjectReferenceMaterialReadAuthorizationPort` 接收实际调用者、项目、参考/结果/Run绑定、原插件完整包、配置修订、operation及确切origin/path。宿主组合层必须核对该用途的当前读取资格、安装/配置和批准；已有项目阅读或旧JSON网络批准不能隐式构造它。当前实现要求显式注入该可信端口，没有默认allow策略，也没有把测试具名策略作为生产配置。

读取顺序为：核验真实采用来源 → 读取授权 → DNS/生产网络策略 → 重新核验来源与读取授权 → 固定地址GET → 检查字节 → 再核验来源与授权。数据库事务在网络调用前已经结束，不持有写锁等待供应商。并发采用、需求/剧本失效、项目变更或权限撤销时失败，不返回旧输入为当前素材。

## 网络与格式范围

继续使用原 `NetworkEgressResolver`、`ProductionNetworkEgressPolicy` 和 `PinnedNodeHttpTransport`。只允许公网HTTPS地址，连接固定已核验IP，校验TLS主机名，不跟随重定向，不使用响应中的新地址。该读取请求只发送GET，无请求体、凭据或生成提交。

显式新增 `imageMaterial` 传输模式：只接受GET、无body、maxRequestBytes=0，响应硬上限16MiB。原默认 `standard` 模式仍为1MiB；原JSON调用、POST请求体上限及TLS/地址校验保持。请求带30秒取消信号，调用者可提前取消。

首批只接已核验Comfy SaveImage的8-bit RGB/RGBA非隔行PNG：最大4096×4096、4096个chunk、16MiB编码字节。检查签名、chunk长度/CRC、必要顺序、IDAT解压消费量与扫描行长度/过滤类型；解压上限由实际宽高和通道数计算。不解释文本或压缩附属元数据，不接受APNG、调色板/16-bit/隔行格式、损坏图、HTML、压缩HTTP响应或不一致的Content-Length。此项是受限技术检查，不代表所有PNG规格语义或画面质量通过。其他媒体格式以后按确切供应商用途另接。

CRC及有界inflate沿[PNG规范](https://www.w3.org/TR/png/)和当前固定[Node24.18.1接口](https://github.com/nodejs/node/blob/v24.18.1/doc/api/zlib.md)。没有新依赖、运行时或构建系统。

## 观察不是冻结

返回的 `ProjectReferenceMaterialObservation` 记录确切来源、原服务/output引用、PNG字节SHA-256、长度、尺寸和观察时间。历史配置及凭据绑定不返回；没有HTTP/SDK/事件/数据库形状变更或迁移。

这是一次读取观察，不是可供执行的持久素材回执。供应商文件可能在观察后被替换，不能把原文件名加上摘要就交给下游执行。后续源归档已把确切字节保存为受控、归属于原请求的不可变素材；仍须单独完成供应商目标副本，验证目标字节、身份与可读性。源与目标分别记录。跨服务必须有目标授权，不能复用裸源文件名。若采取重新编码的复制工作流，还需要验证画面数据与源一致，不能要求原PNG字节摘要相同来伪造传输证明。

素材准备、输入保存和Run提交各自有原请求键与状态。外部传输不在数据库事务内伪装成原子提交；缺少目标回执或受理未知时核验原操作，不能自动重发。执行准入仍须重核采用修订、配置、批准和准备结果，冻结原任务输入。这些是后续实施要求，当前没有开放T10/D18的新项目执行。

## 验收范围

最终102项相关检查通过、零跳过；其中新增22项覆盖读取、供应商解释、PNG和显式传输模式，是总数的子集。双库检查使用真实项目/采用参考/原Run及结果证明，媒体授权、供应商解释、DNS与HTTP是具名端口夹具。原HTTP传输测试另用实际本地socket验证超过1MiB的读取和旧限制；这些不冒充正式App、插件媒体工具或真实项目Comfy执行。

真实外部专项用新生产网络策略、固定地址传输及PNG检查，对上一轮两张示例生成结果各做一次GET。T10为1,701,417字节、1536×1024；D18为546,020字节、832×480。两项字节摘要均与原记录相同，POST为0。这里没有下载保存媒体，也未重新生成。

首次系统DNS把域名映射到代理保留地址198.18.12.7，生产策略在dispatch前拒绝。保留拒绝日志；两份独立公网DNS查询均返回116.172.66.190。专项显式使用1.1.1.1的实时解析，再沿原生产策略/TLS/连接地址校验完成两次读取。没有硬编码目标IP或放宽保留地址规则；产品默认DNS配置未改变。

证据：`output/extensions/checks/project-material-read-20261006/`。Runtime-worker/Application/Store类型检查、原网络客户端回归、架构边界与格式检查通过；SDK源/dist/tar、用户App、冻结App及20.0.1/20.0.2完整包核验保持。两轮自有Postgres正常停止并清理，全部运行已结束。
