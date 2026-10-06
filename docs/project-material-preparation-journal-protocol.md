# 项目素材准备记录与唯一发送协调

2026-10-06。状态：真实项目的独立准备journal已实现并通过SQLite/Postgres行为验证。宿主[传输适配器](./comfyui-material-transfer-protocol.md)已完成真实外部组件验证；**准备应用服务与实际传输的组合、媒体输入/Run及页面/Agent接线尚未完成。** 一个journal回执不代表已上传或已具备媒体执行能力，完整目标继续ACTIVE。

## 原请求与不可变快照

宿主内部业务请求只包含源冻结请求、目标profile/plugin/config修订和独立准备键。源请求含真实调用者及当前采用的项目/资产修订，上层服务从实际调用者填入身份；UI/Agent不提交actor、源记录、服务地址、目标文件名、正文或摘要。当前尚未注册这个公开业务服务。

准备键按完整actor、项目及idempotencyKey定位，项目内换资产或换配置不能复用同键。requestDigest冻结完整业务请求。intentId为该范围的确定性SHA身份，供应商preparationId是独立UUIDv4，两者与原源冻结键、来源生成Run、媒体输入及未来生成operation分开。

第一次保存同时冻结源归档记录、真实目标完整安装/选择与配置、规范化Comfy服务地址、独立output路径、上传正文请求摘要及创建时间。相同键返回原快照；并发调用者提出不同UUID时复用先保存的原路径，上层必须按返回的原准备身份重新渲染并核对上传请求摘要。改变源字节/归档或目标完整快照冲突；另一业务请求不能占用原preparationId。新增默认配置只影响新请求，原请求沿确切配置修订与路径恢复。

全记录最多96KiB，源记录与配置仍经过各自原解析上限。解析先作受限描述符复制，拒绝嵌套getter、Proxy、cycle、非JSON和过量深度/节点；不执行toJSON或回调。配置及捕获请求不可变。完整内部记录不能直接注入模型上下文；后续Agent只取得有界业务摘要和状态，不读取配置/归档内部数据。

## 独立存储与状态历史

独立v1迁移建立原快照、不可变状态事件、当前head及专属schema marker四张表，不修改原项目/资产、配置、Run、资金或安装迁移。构造不迁移，迁移必须显式调用；原资产schema先核验，新marker绑定真实DDL、约束、触发器/函数和索引，缺少或损坏时拒绝，不能自动修补部分历史。SQLite同时要求父连接开启foreign_keys。

原快照及每条事件禁止SQL UPDATE/DELETE；head只能引用真实事件并按合法阶段增加一个revision。SQL和解析同时限制状态，历史最多四个事件：

- reserved → dispatching：CAS唯一claim；只有claimed结果可继续取得独立网络授权。其他调用者得到existing，不再次发送。
- dispatching → unknownOutcome / verified / rejected：保存原未知结果、匹配的字节观察或明确拒绝。
- unknownOutcome → verified / rejected：只协调原目标查询结果，不能回到reserved/dispatching。
- verified、rejected终态保留原结果；再次claim只返回existing。

查询核验整段有界历史、连续revision、合法转换、单调时间、head/事件/原快照摘要及物理索引，不只读取最后一条JSON。verified必须记录与原源摘要、长度、尺寸完全匹配的观察及检查时间；它是过去的观察，不能代替当前文件可读证明、PDP或Run准入。终态不通过自动重传修复。

## 实际来源、安装与事务资格

所有读写都要求新的`crewon.project-material-preparation-commit.v1`资格，原资产UI、文字计划或任务资格不能代替。资格绑定完整业务请求，必须有独立外部PDP/profile/owner检查与同步active fence，无允许默认值。回调是宿主内部能力，不通过JSON输入；实际Main批准与服务组合仍待接线。

同一父连接核验原项目归属及active状态、当前采用指针、设定/参考修订、需求/剧本和大纲依赖、原结果链接、实际来源Run/admission/funding、原operation和真实结果验证器、历史来源配置。再核验目标实际配置完整记录、真实安装选择与package全快照，含安装审计和选择revision。缺少验证器、撤安装、更改原配置、来源过期、跨归属或归档记录自报的Run/结果证明均拒绝。

SQLite在BEGIN IMMEDIATE之前完成异步外部检查，锁内全部同步；Postgres每次只借一个父pool连接，来源项目锁、目标安装共享锁、CAS和最终复核都在该连接上，max=1可运行。外部事务检查不能借这个pool，也不能包含文件/DNS/HTTP。每个实际SQL步骤前后有active fence；取得状态后再核验真实来源和目标，最终资格失效回滚完整写入。发送后若权限或来源变化阻止保存新事件，原dispatching仍保留，不能当作从未提交。

journal验证项目和来源证明，不打开源归档文件，不解释PNG或执行网络请求；字节与实际上传摘要须由准备应用服务通过真正的源冻结服务和上传适配器核验。归档记录、matching observation DTO及claimed状态均不能单独授予文件/网络或媒体Run权限。不能把具名观察夹具当作实际供应商验证。

## 下一项的组合顺序

实际业务服务先按原准备键查journal，再核验真实目标和源冻结。如果已存在请求，只允许读取原源归档；归档缺失/损坏不能再次GET源图、生成新图或用新准备替代原状态。新请求沿独立源冻结资格获取确切字节。

按返回的原UUID、源字节与目标配置渲染正文并对照原请求摘要；沿原生产网络策略解析目标。发送前重核资格并取得唯一claim，发送后只读取原目标文件核对实际字节。dispatching/unknown冷恢复只GET原路径，404或DNS错误不能证明没有上传。原副本每次用于媒体执行前再次核验，外部文件不能假设不可变。

随后保存版本化媒体输入，逐项冻结T10/D18真实素材角色与准备来源，在原Run准入事务内再次核验；先完成真实项目的手动生成/采用链，再让Agent的有界媒体步骤调用同一命令。旧文字计划和原前端保持。

## 验证证据

187项相关检查全部通过、零跳过；新增32项双库准备检查是其中的子集。项目、采用参考、原来源Run及安装/配置用真实数据库；归档、目标字节观察、包内容与外部准备PDP是具名夹具。验证真实两实例单路径/单claim、父句柄关闭后原dispatch/unknown恢复、不可变SQL历史、撤资格后的完整回滚、配置默认值不改绑、伪造来源、嵌套getter/Proxy拒绝及旧权限拒绝。原消息/任务/资金和资产计数保持，不新增Run或上传。

Application/Store/Runtime-worker类型、架构边界及格式检查通过；SDK源/dist/tar、旧完整插件包及用户/冻结App保持。证据为`output/extensions/checks/project-material-preparation-journal-20261006/`。两次自有Postgres正常关闭并清理。首次SQLite检查的测试调用参数错误及对应类型错误保留，修正为实际服务的具名参数后通过；未通过弱化检查取得绿色结果。本轮没有远端HTTP、GPU生成、Main/正式App或完整媒体阶段验收。
