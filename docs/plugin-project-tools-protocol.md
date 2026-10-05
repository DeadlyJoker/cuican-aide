# 短剧 Agent 项目工具协议 v1

本协议是现有插件执行服务之外新增的 Node 能力服务 `crewon.project-tools@1`。原 SDK 0.1.0、执行协议 v1、原短剧 12 包和宿主前端保持兼容；短剧 13 包同包增加文字阶段工具与原 Krea2 预设。文本由当前 Agent 模型创作，工具负责权限、版本、来源、校验与保存，不另建模型运行时。

公开入口是 `@crewon/contracts/project-tools`。`packages/contracts/src/plugin-project-tools-service.ts` 不依赖宿主实现、SDK或HTTP生成类型，可以作为单文件公开协议随第三方插件分发。示例使用其字节一致副本并固定 SHA-256；独立构建只依赖发布的 SDK、公开协议和自身源文件，没有私有宿主源码导入。仓库检查同时验证副本与公开源一致。

## 服务和工具

| 方法                                       | 短剧工具 operationId          | 作用                                           |
| ------------------------------------------ | ----------------------------- | ---------------------------------------------- |
| listProjects / readProject                 | project_list / project_read   | 读取可访问项目和需求元数据                     |
| createProject / appendBrief                | project_create / brief_append | 保存想法、追加需求版本                         |
| readOutline / readScript                   | outline_read / script_read    | 读取大纲或单集剧本的当前头、选用状态和过期原因 |
| readContent                                | content_read                  | 分段读取确切需求或成果版本正文                 |
| listRevisions                              | text_history                  | 分页读取候选版本元数据                         |
| saveOutlineCandidate / saveScriptCandidate | outline_save / script_save    | 校验并追加候选，不自动采用                     |
| selectRevision / setLocked                 | text_select / text_lock       | CAS采用版本、锁定或解锁当前选用                |

所有方法只接收 `{command, request}`。`command` 是当前 Worker 转发的真实对象，类型故意 opaque。不能构造JSON、复制命令、借用UI invocationRef或在插件setup中获得执行权限。actor、signal、租约和幂等键由宿主取得，不接受模型传入。

Workflow manifest现有有界Schema不支持null或union，模型入参中省略 `listProjects.after` 和 `saveScriptCandidate.outline` 分别规范化成null；只有这两处规范化，其他字段严格校验。内容读取的source按kind检查确切字段。安装清单、模型工具定义和运行时策略必须一致。

读取页最多4条；正文每页最多1024个Unicode码点，以实际不可变源版本、contentDigest和nextOffset继续，不能将截取片段当成完整JSON。保存只返回头和不可变修订元数据，不把长剧本回显。工具现有输出Schema用 `{resultJson: string}` 承载这项独立协议的响应；包括包装在内最多8192 UTF-8字节。无身份、凭据、安装权威或数据库连接进入模型结果。

## 真实执行资格

宿主配置必须显式启用 `projectTools: {version: "crewon.project-tools.v1", authorization}`，这里的authorization是独立项目权限端口，不能把旧Run/Extension权限接口强转过来。未启用时不迁移项目表、不暴露该服务，旧执行路径保持原行为。

首期只为真实已持久准入的插件任务Run开放。当前原始普通对话Run的admission=null分支保持原行为；不能仅凭安装信任，假称普通聊天已经自动获得短剧工具。工作台/项目对话启动入口和普通对话能力发现仍需对应实施阶段接入真实任务准入。

每次工具调用验证当前实际包和工具名称/效果/capability、Run创建者解析出的完整主体、当前项目权限及实际Worker租约。插件setup可以获取服务对象，任何业务读写仍需要当前WeakMap派发资格。服务生命周期撤销后停止新操作，关闭时等待在途业务实际结束。

写入使用独立 `crewon.creative-project-run-commit.v1` 事务资格，同一SQLite或PostgreSQL提交连接再次核验实际Run、Tool receipt/actionDigest/inputDigest、原始准入、当前step/attempt/claim租约、确切配置/目标和完整安装选择。外部权限/主体/发布者复核与事务内事实读取分开，避免提交时重借同一连接池。没有UI contribution/action/authorityEpoch冒充工具资格。

幂等键来自实际原Tool receipt/execution/action，不由模型决定。真正Worker重启后同一Tool沿原回执恢复；不同手动操作或新的Tool是不同请求，不能承诺尚未实施的跨入口执行意图去重。原UI六动作事务资格仍只支持原六动作，不借它写新大纲/剧本。

## 范围与下一步

这一阶段把“想法→需求→大纲→单集剧本”的真实Agent业务工具接到现有Worker与共享存储。Short14 已通过独立[插件 UI 文本协议](./plugin-project-texts-ui-protocol.md)接通工作台文字编辑、历史、采用与锁定。后续工作是未完成文本请求冷恢复、项目 Agent 对话启动/发现、持久阶段计划/委托，以及资产、分镜、视频、声音和合成的真实工作流。已有方案见 `short-drama-agent-workflow-design.md`；本协议不把尚未接通的阶段宣称为可执行。
