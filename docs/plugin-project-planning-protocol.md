# 原 Agent 聊天中的短剧项目建议

本协议用于 Short18。普通聊天处理用户的想法，产生可交给短剧工作台确认的建议；实际项目、关联对话和持久文字计划仍沿原公开服务创建。后续角色、场景、分镜、视频、声音和成片按[协同设计](./short-drama-agent-workflow-design.md)扩展。建议工具自身不会创建项目或执行生成。

## 聊天与工作台

原默认 Agent 增加两个服务器提供的工具：

- `crewon_project_capabilities`：读取当前用户实际可见、已启用的插件能力及准备状态。
- `crewon_project_propose`：根据该次实际能力读取提出项目名称、需求、起止阶段、集数、创作要求和采用方式。

工具只挂在真实普通聊天 Run 上。插件 Run、阶段 Run、其他 Kernel 或未满足条件的会话不会获得这些工具。运行时逐次复核当前用户、Thread、Run、claim、取消状态、安装选择和 Main 审批；发现能力不要求生成执行已准备，`executionReady` 仅陈述实际准备状态。

成功建议作为原 `tool.completed` 输出持久保存，并沿原 GET、SSE 和事件游标重连读取。完整 JSON 不超过 8,192 字节，不扩大原聊天事件预算。卡片只接受正确工具的成功输出，且来源 Run、Thread 和 call 必须与实际消息一致；普通模型文字或其他工具输出不会成为项目卡片。

用户点击卡片时，宿主仅打开当前安装的确切插件模块并传入建议。插件版本、发布者、包摘要或当前对话变化后，旧建议不能自动打开另一版本。查看建议只预填创建弹窗；用户可以修改需求再确认。保存项目后，执行计划预填到这个新项目，仍需选择真实项目对话并确认开始。取消建议后普通“新建项目”继续使用空表单。原全局导航、样式、左右栏和账户入口保持原有实现。

## 独立插件协议

插件声明可选 `crewon.project-planning-drafts@1`，通过原 `main.content` 模块接收 `data.projectPlanningDraft`。Main 仅在同一个确切源同时声明项目 UI、文字、对话和文字计划服务时批准此能力。Short16/17 没有这项声明，不被默认为支持新建议。

公开类型和严格解析器通过 `@crewon/contracts/project-planning` 发布。独立示例携带同一公开类型及固定摘要的自包含解析器，继续使用冻结 `@crewon/plugin-sdk@0.1.0`，无需私有宿主源码依赖或新的运行时。

建议字段为：

| 字段                            | 范围                                                                 |
| ------------------------------- | -------------------------------------------------------------------- |
| capability/source               | 当前发现的能力 ID，以及确切插件、发布者、版本、包摘要和 contribution |
| origin                          | 由宿主填写的原 Run、Thread、call，模型不能填写                       |
| title / briefText / instruction | 分别最多 128 / 4,096 / 2,048 UTF-8 字节                              |
| start / target                  | 起点需求或大纲；终点需求、大纲或剧本；不允许逆序                     |
| episodeCount                    | 只做需求时为 null；其余 1–16 集                                      |
| adoption                        | `manual` 或 `whenUnchanged`；执行授权由原计划确认产生                |

建议、准备状态和 UI props 都是数据，不构成项目权限、执行委托或调用身份。原有公共服务继续核验真正的 mounted invocation 和当前用户。持久计划限制、暂停、恢复、成果检查和自动采用规则见[文字计划协议](./plugin-project-text-plans-protocol.md)。

## 查询升级前的生图任务

Short18 另声明可选 `crewon.project-historical-queries@1`。原同包查询服务的命名空间、重复源规则和恢复资格保持原样。新服务仅接受已有项目成果引用、原 operation、实际 Thread 的 CAS 和原请求键；客户端不能指定执行插件或工作流。

Main 为当前短剧模块批准独立历史目标，固定旧包的插件、发布者、版本、包/manifest/implementation 摘要、contribution 和 query action。实际提交前按原生成记录、Run、配置、资金记录及 operation 解析目标，再核验当前用户、准备、配置和目标权限。查询沿原 Control、Worker、Node 和历史供应商记录执行，不新建生成操作，不改变原生成输入。

宿主的 `projectHistoricalQueryHostContext` 明确为 `crewon.project-historical-query-host-context.v1`，恢复范围是 `session-only`。热会话丢失回执时只能重试原键和正文；接受后的业务回执可独立重读，但不能声称未确认的 UI 查询跨 App 重启自动恢复。新旧查询在同一模块有未确认操作时互斥；新查询不借用旧 journal 的 stage/restore 资格。未知生成结果仍只能查询原 operation，不能重新生成来绕过。

真实 Main、普通 Kernel、SQLite、原 HTTP/SSE 与冷读取专项，以及真实双库的旧包查询链用于验证上述边界。具名模型或供应商夹具的验证范围必须单独标注，不代表正式用户模型、公网供应商或完整短剧生产已经验收。
