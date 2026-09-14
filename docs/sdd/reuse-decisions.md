# 开源复用选型与实施约束

2026-09-14，用户明确要求避免纯手写，充分利用成熟开源组件与能力以提高稳定性。五个开发任务均已收到约束。下表是选型工作清单，不表示候选已被采用或完成兼容验收。

## 选型责任

| 任务 | 优先复用与候选                                                                                                                  | 必要自研边界                                               | 要提交的证据                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| F01  | 评估 ExcelJS 等高层 XLSX 库承担单元格、样式和读写；已有 fflate/fast-xml-parser 用于确有必要的有限结构操作；CSV 使用成熟解析能力 | 业务汇总/异常规则、交付身份与版本冲突、经验证的窄模板适配  | 真实模板往返、样式/公式/备注保留、7订单结果、变更后重开与恢复；不以自制样本证明所有模板保真          |
| F02  | 评估 rrweb 的事件采集/过滤能力；与 F05 共享成熟可访问语义库，如 dom-accessibility-api；复用 Electron 截图、下载与隔离 preload   | 授权的语义步骤投影、暂停/删步、C01、敏感策略与有界证据管理 | 现有隔离页中的实际采集、标签/角色一致性、暂停与敏感字段反例；需要全 DOM 重放才可用的候选可说明不适配 |
| F03  | 既有模型/Run/结构化输出链路、schema/Markdown 工具、SQLite 模式与 UI 组件                                                        | Skill 生命周期、不可变版本、实际试跑关联和唯一准入         | 真实录制导入与模型草稿路径、保存重开、真实 Run 身份及撤权；规则预处理不冒充模型生成                  |
| F04  | 既有 scheduler、时区计算、receipt、客户端和表单；标准 Intl 或已用时间库                                                         | 固定版本与周期参数映射、兼容投影、失败状态                 | 跨周/时区边界、同次重试不变、BFF穿透、旧客户端兼容；不增加新调度器                                   |
| F05  | 优先验证 Playwright/Puppeteer 对同一 WebContentsView 的接入；若不适配，复用 Electron/Chromium CDP 与成熟可访问语义实现          | C05、宿主授权、受限执行适配、请求去重和文件交接            | 真实同页会话与登录保留、定位与动作效果、下载及取消/恢复；不通过另起浏览器规避适配问题                |

每个 owner 在自己的 SDD 补充最终采用项、具体版本、许可/维护状态、未采用理由与测试结果。新增依赖通过 pnpm 和锁文件管理；生产、preload 和测试依赖的职责明确。F02/F05 的公共语义模块确定一个 owner，避免各自实现一套可访问名称或角色算法。

## 当前采用与集成状态

根协调已在隔离集成分支实际合入 F01 的 ExcelJS 4.4.0、csv-parse 7、xlsx-calc 0.9.2，F02 的 dom-accessibility-api 0.7.1，F03 的 Zod 4.4.3 与 js-yaml 4.3.0。F04 继续复用既有 scheduler 与 Intl，没有增加调度引擎。这些不是只有选型文档：表格文件处理、录制语义和严格契约校验已使用上述库执行，根协调的合并后检查见 [集成进度](integration-progress.md)。

F05 已在真实同一 WebContentsView 探针中使用 Puppeteer Core 25.9.0 的公开 ExtensionTransport/connect 与 Locator 完成填写、选择、点击、导航失效、取消及真实 CSV 下载；focus emulation 在动作结束和取消后恢复。该结果由 F05 报告，实际录制宿主、授权与交付链路仍由该任务继续贯通，尚未作为本集成分支完成验收。

自有代码限定于业务规则、身份与授权、不可变版本、事务一致性、敏感过滤、有限资源预算和跨组件适配。没有保留自写的高层 XLSX writer、CSV 状态机、公式计算引擎或可访问名称算法。即使采用成熟库，模板语义、公式错误、授权与重试边界仍须由产品行为测试证明。

## 选型过程与评审记录

以下为任务已回报的选型与动作，不能视为全部实现或集成验收通过：

- F01 的 ExcelJS 4.4.0 真实模板探针保留了备注、合并、行列尺寸和金额格式，也观察到原公式缓存未重算；正在评估计算库与 csv-parse。协调明确：OOXML part 字节改变不等于语义丢失，默认使用成熟库读写，保留窄模板补丁须有首发范围内真实语义/元数据丢失证据，不能以要求所有 part 原样不变扩大自研面。
- F02 已选定 `dom-accessibility-api@0.7.1`，报告核对 MIT 许可，替换手写名称/角色算法；担任 F02/F05 公共语义薄模块 owner，隔离 preload 打包和真实页面兼容验证继续。完整 rrweb 录制器未采用，理由是本轮无需全站 DOM 重建。
- F03 已选定仓库已有版本的 Zod 与 js-yaml 承担结构校验/序列化，并复用现有 Turn/Run 生成模型草稿；需验证严格未知字段拒绝、规范化和摘要语义不因换库改变。
- F04 确认继续复用已有 scheduler、UI、权威契约 parser 和 Node Intl；限定日期规则无需再加时间或 schema 框架，维护时区/DST/跨周行为证据。
- F05 已暂停扩展手写页面执行逻辑。首轮真实同页探针中，Puppeteer 原生连接的 `Target.getBrowserContexts` 在 Electron debugger 被拒绝；正在验证官方单 tab transport 的兼容路径，通过前不标为已采用。适配只能使用公开接口并限于当前授权 WebContentsView，不做私有 API 分叉；若受限，仍复用官方 CDP 和共享语义模块，并记录定位/动作/导航/取消/下载证据。

F05 后续探针已通过公开 `ExtensionTransport.connectTab` + `connect` 在同一实际 WebContentsView 执行 Locator fill/click，使用 Puppeteer Core 25.9.0 与 Electron 43.4.1。协调只读核对了探针脚本：这是独立合成页面，尚未验证 F02 教学窗口、授权或登录会话集成。生产化继续核对单会话传输入口、旧命令失效、监听清理，以及自动原生输入与人工接管事件的区别；select、导航、取消和下载仍待补证据。

F01 已报告移除自制 OOXML 写入器及样式克隆，改用 ExcelJS 公开 workbook/cell/style 读写，csv-parse 替代自写状态机；输入 ZIP/结构检查保留。换库后的业务、模板语义与恢复用例正在复验，旧引擎 HTTP 通过不算新实现证据。公式候选的错误结果可能通过单元格错误类型返回，需核验全部结果并拒绝陈旧缓存，不能仅以未抛异常判成功。

F02 已提交共享语义模块 `5bac9659d`，报告 56 个行为测试覆盖多 label、aria-labelledby 和中文名称；F05 可引用该模块。脚本驱动的真实 Electron GUI 与人工/CUA操作分别记录，本机锁屏导致的人工验收缺口保持可见，不用前者冒称后者。

## 已核对的上游事实

- ExcelJS 提供 XLSX 数据与样式读写能力，作为 F01 高层库候选；支持列表不能代替 CrewON 模板往返验收。[项目文档](https://github.com/exceljs/exceljs)
- Playwright 的 Electron API 标为实验性；通过 CDP 接入已有 Chromium 与原生 Playwright 协议存在能力差异。因此同一 WebContentsView 的接入要先做实际兼容验证，不能仅凭库名称承诺稳定。[Electron API](https://playwright.dev/docs/api/class-electron)、[CDP 接入](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
- Electron 提供 `webContents.debugger` 作为 CDP 的宿主内传输入口，可以评估使用它接入官方浏览器能力；其 attach/detach 与页面关闭、DevTools 行为必须纳入恢复测试。[Debugger API](https://www.electronjs.org/docs/latest/api/debugger)
- rrweb 提供事件记录、停止采集和输入/文本过滤配置；本轮需要语义示教和有界证据，是否采用完整录制器由隔离页与数据范围验证决定。[录制指南](https://github.com/rrweb-io/rrweb/blob/main/guide.md)
- dom-accessibility-api 提供可访问名称与描述算法，可作为录制与执行共享语义能力的候选；依赖输出还需经过 CrewON 敏感字段和大小策略。[项目文档](https://github.com/eps1lon/dom-accessibility-api)

上述官方文档已查阅；具体依赖版本的维护、许可、已知问题与本仓库兼容性仍由各 owner 在采用时确认。已有依赖也需核对，不能因为已出现在锁文件中就自动认定适合新的文件上传或执行路径。
