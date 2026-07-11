# CrewON 三场景与执行主体实施规格 v1

> 本文是三场景开发、测试与验收的唯一规范来源。若与 `command-scene-functional-design.md` 或旧桌面设计产物冲突，以本文为准。首页默认 CrewON 单 Agent，同时允许选择已定义的单 Agent 或小队；实现前必须同步更新桌面设计产物和 `crewon-design-reference`，避免后续验收使用相反标准。

## 1. 可落地结论

本规格将「日常办公 / 生码 / 设计创意」定义为三个可执行的 Runtime Preset，并将执行主体建模为独立维度。场景差异必须同时落在两层：

1. 产品层：用户看到不同的输入方式、推荐能力、运行反馈和结果承载。
2. Agent 层：模型收到不同的稳定指令、上下文结构、能力偏好、完成标准和安全边界。

只修改标签、placeholder 和快捷 prompt 不算场景功能完成。只注入不同系统提示词、但产品界面和交付形态相同，也不算场景功能完成。

所有任务遵守：

- 主会话只有一个主 Agent。
- 默认执行主体为 CrewON，解析为 `executionStrategy=single`。
- 用户可选择已定义的单 Agent 或小队；Scene 与执行主体互不自动切换。
- 单 Agent 目标关闭 multi-agent runtime，不暴露 spawn/list/send 等多 Agent 工具；不能只依靠提示词要求模型不要委派。
- 小队目标仅在定义存在、已授权且 Team Runtime 可用时解析为 `team`，并只暴露有界 Team 工具。
- 场景在新线程创建时确定，线程运行后不原地切换。

## 2. 当前实现与目标差距

当前前端 `ThreadRuntimeSettings` 只包含：

- `model`
- `approvalPolicy`
- `sandboxMode`

当前 `thread/start` 和 `turn/start` 调用也只传递这些设置。首页 Scene 状态没有进入 Agent 请求；`design` 还会映射成现有 `code` WorkMode。

目标链路应为：

```text
用户选择 Scene 与执行主体（默认 CrewON）
  → 应用 ScenePreset
  → 用户补充上下文与能力
  → 生成 SceneRuntimeContract
  → Runtime Resolver 校验场景、模式、能力、上下文与权限
  → thread/start 写入可恢复的场景身份
  → turn/start 写入可信场景契约、真实能力选择和有界上下文引用
  → 主 Agent 按场景合同与解析后的 single/team 策略执行
  → UI 按 Deliverable Adapter 展示结果
```

## 3. 核心数据模型

### 3.1 场景预设

```ts
type SceneProfile = "office" | "code" | "design";

type OfficeMode = "organize" | "write" | "analyze" | "coordinate";
type CodeMode = "ask" | "plan" | "implement" | "review";
type DesignMode = "explore" | "refine" | "produce" | "inspect";
type SceneInteractionMode = OfficeMode | CodeMode | DesignMode;

type LocalWritePolicy = "read-only" | "workspace-write";
type ExternalActionPolicy = "draft-only" | "confirm-each";

type OfficeDeliverable =
  | "document"
  | "table"
  | "action-list"
  | "message-draft"
  | "knowledge-entry";

type CodeDeliverable =
  | "implementation-plan"
  | "code-change"
  | "code-review";

type DesignDeliverable =
  | "design-directions"
  | "design-artifact"
  | "design-review"
  | "handoff-spec";

type SceneDeliverable =
  | "conversation"
  | OfficeDeliverable
  | CodeDeliverable
  | DesignDeliverable;

type SceneContextKind =
  | "workspace"
  | "repository"
  | "branch"
  | "file"
  | "document"
  | "thread"
  | "issue"
  | "pull-request"
  | "calendar"
  | "contact"
  | "date-range"
  | "figma-node"
  | "knowledge"
  | "image"
  | "web-page"
  | "log"
  | "brief"
  | "brand"
  | "canvas-spec";

type SceneContextSlot = {
  id: string;
  labelKey: string;
  accepts: SceneContextKind[];
  maxItems: number;
};

type SceneCapabilitySelector = {
  kind: "skill" | "plugin" | "mcp" | "app" | "tool" | "knowledge";
  ids?: string[];
  tags?: string[];
};

type SceneCapabilityPreference = {
  selector: SceneCapabilitySelector;
  recommendation: "preferred" | "optional";
};

type RuntimeCapabilitySelector = {
  kind: "skill" | "mcp" | "app" | "tool" | "knowledge";
  ids?: string[];
  tags?: string[];
};

type ScenePreset = {
  profile: SceneProfile;
  labelKey: string;
  subtitleKey: string;
  placeholderKey: string;
  presetVersion: number;
  instructionVersion: number;
  modeSpecs: SceneModeSpec[];
  defaultMode: "auto" | SceneInteractionMode;
  contextSlots: SceneContextSlot[];
  capabilityRecommendations: SceneCapabilityPreference[];
  defaultDeliverable: SceneDeliverable;
  recommendedPermission: "auto-local" | "on-request";
  quickActions: SceneQuickAction[];
};
```

所有展示字段使用现有 i18n key，不把中文文案直接写死在 Runtime domain object；可信 contract 也不携带这些展示字符串。

`ids` 和 `tags` 必须来自平台稳定元数据；名称关键字只允许作为无匹配时的展示降级，不作为 Runtime 绑定依据。第三方 Plugin 自报 tag 只能参与推荐，未经平台验证的 tag 不能满足 `required` 或授予 ToolEffect。所有可变选择还要记录来源：

当 `defaultMode="auto"` 时，`defaultDeliverable` 只用于首页预告，不直接成为可写任务合同。Resolver 只有在 mode 与 deliverable 组合通过校验后才生成具体合同；未解析时使用只读的 conversation 合同。

```ts
type SelectionOrigin = "scene-default" | "quick-action" | "user";

type Selected<T> = {
  value: T;
  origin: SelectionOrigin;
};
```

切换 Scene 时只自动替换 `scene-default`；`quick-action` 项标记不匹配并允许清理；`user` 项保留，除非能力已不可用。

### 3.2 场景 × 任务方式执行合同

完成标准和写入边界必须由 Scene 与 mode 共同决定，不能只按 Scene 定义：

```ts
type SceneTaskContract =
  | { scene: SceneProfile; mode: "auto"; deliverable: "conversation"; localWritePolicy: "read-only"; externalActionPolicy: "draft-only" }
  | { scene: "office"; mode: "organize" | "write" | "analyze"; deliverable: OfficeDeliverable; localWritePolicy: "workspace-write"; externalActionPolicy: "draft-only" }
  | { scene: "office"; mode: "coordinate"; deliverable: OfficeDeliverable; localWritePolicy: "workspace-write"; externalActionPolicy: "confirm-each" }
  | { scene: "code"; mode: "ask"; deliverable: "conversation"; localWritePolicy: "read-only"; externalActionPolicy: "draft-only" }
  | { scene: "code"; mode: "plan"; deliverable: "implementation-plan"; localWritePolicy: "read-only"; externalActionPolicy: "draft-only" }
  | { scene: "code"; mode: "implement"; deliverable: "code-change"; localWritePolicy: "workspace-write"; externalActionPolicy: "confirm-each" }
  | { scene: "code"; mode: "review"; deliverable: "code-review"; localWritePolicy: "read-only"; externalActionPolicy: "draft-only" }
  | { scene: "design"; mode: "explore"; deliverable: "design-directions"; localWritePolicy: "workspace-write"; externalActionPolicy: "draft-only" }
  | { scene: "design"; mode: "refine" | "produce"; deliverable: "design-artifact" | "handoff-spec"; localWritePolicy: "workspace-write"; externalActionPolicy: "confirm-each" }
  | { scene: "design"; mode: "inspect"; deliverable: "design-review"; localWritePolicy: "read-only"; externalActionPolicy: "draft-only" };

type SceneCapabilityRequirement = {
  id: string;
  selectors: RuntimeCapabilitySelector[];
  match: "any" | "all";
  requirement: "required" | "preferred" | "optional";
};

type SceneContextRequirement = {
  id: string;
  selectors: Array<{
    slotId: string;
    kinds?: SceneContextKind[];
  }>;
  match: "any" | "all";
};

type SceneExecutionAlternative = {
  id: string;
  contextRequirements: SceneContextRequirement[];
  capabilityRequirements: SceneCapabilityRequirement[];
};

type SceneModeSpec = {
  mode: SceneInteractionMode | "auto";
  defaultContract: SceneTaskContract;
  allowedDeliverables: SceneDeliverable[];
  executionAlternatives: SceneExecutionAlternative[];
  completionCheckIds: string[];
};

type CompletionCheckSpec = {
  id: string;
  evidence: "agent-report" | "tool-event" | "artifact" | "approval-event";
  blocking: boolean;
  appliesWhen?: "always" | "artifact-created" | "external-action-requested" | "workspace-changed";
};
```

Builder 必须拒绝 `office + implement`、`code + explore` 等无效组合。required context、能力要求和完成检查来自具体 `SceneModeSpec`，不能放在 Scene 全局。一个 mode 只需满足一个 `executionAlternative`，但该 alternative 内的 context 与 capability requirements 必须一起满足，不能把 local context 与 remote capability 错配。例如 code review 的合法路径是“本地 workspace + workspace.read”或“remote PR + github.pr.read”。`completionCheckIds` 是服务端 Registry 的闭集 ID，最多 16 项，不允许前端提交自由文本；检查尽量由真实 tool/artifact/approval event 取证，无法验证时显示 unverified，不能伪造完成。

Plugin 只能进入推荐或安装选择，不能成为 runtime required selector；安装后必须展开为其中可验证的 Skill/MCP/App/Tool 再满足 requirement。

Registry 启动校验还要保证：mode spec 的 contract scene/mode 与父 preset 一致、allowed deliverable 都属于合法 union、context requirement selector 引用的 slot/kind 合法、quick action 引用的 mode/slot/capability 可解析。

`localWritePolicy` 决定 Agent 是否可改本地工作区；`externalActionPolicy` 决定是否只能生成草稿，二者不能合并为一个模糊的“权限”。两者都是允许上限，不代表 Agent 必须执行写入。`code.plan` 映射为 Codex `CollaborationMode.Plan`；其余 mode 默认使用 `Default`。用户侧只展示一套任务方式，内部保留 `sceneInteractionMode` 与 `collaborationMode` 两个不同概念。

### 3.3 Runtime Resolver

推荐不等于已选择，已选择不等于可使用。发送前必须解析成真实 Runtime：

```ts
type ResolvedCapability = {
  kind: "skill" | "mcp" | "app" | "tool" | "knowledge";
  id: string;
  selectionOrigin: SelectionOrigin;
  availability:
    | "loading"
    | "ready"
    | "auth-required"
    | "permission-denied"
    | "installing"
    | "stale"
    | "error"
    | "unavailable";
  activation: "loaded" | "connected" | "exposed" | "not-active";
};

type ExecutionTargetSelection =
  | { kind: "crewon" }
  | { kind: "agent"; id: string }
  | { kind: "team"; id: string };

type ResolvedExecutionTarget = {
  kind: "crewon" | "agent" | "team";
  token: string;
  executionStrategy: "single" | "team";
  availability: "ready" | "auth-required" | "unavailable" | "error";
};
```

- Skill 必须解析为真实 `UserInput::Skill` 或稳定 skill path。
- MCP/App 必须解析为结构化 mention 和当前实际 tool inventory。
- Tool 的场景排序是 UI 偏好；没有通用 Runtime 过滤 API 时不能声称工具已被禁用或只暴露某个 tool。
- Knowledge 必须解析为可读取资源引用。
- Plugin 只用于安装推荐或 provenance；如果用户选择 Plugin，必须明确转换为 `plugin://` guidance，或展开成其中的 Skill/App/MCP，不能把 Plugin ID 当成可调用能力。
- 若没有任何 execution alternative 能满足其中的 `required` context/capability，固定阻止发送；允许降级的能力必须标为 `preferred`，不能在 Runtime 临时把 required 降级。
- 客户端只提交执行主体种类与稳定 ID；服务端校验定义、所有权、授权和运行时可用性，再签发 opaque `token`。显示名、描述、角色提示词或小队成员名不得进入可信 Application context。
- `crewon` 和 `agent` 只能解析为 `single`；`team` 只能解析为 `team`。任何客户端提交的策略字段都被忽略或拒绝，Scene/quick action 不能改变执行主体。

### 3.4 线程和任务 Runtime

```ts
type SceneRuntimeContract = {
  version: 1;
  sceneId: SceneProfile;
  scenePresetVersion: number;
  sceneInstructionVersion: number;
  executionTargetToken: string;
  executionStrategy: "single" | "team";
  interactionMode: SceneInteractionMode | "auto";
  deliverable: SceneDeliverable;
  localWritePolicy: LocalWritePolicy;
  externalActionPolicy: ExternalActionPolicy;
  collaborationMode: "default" | "plan";
  capabilityHandles: Array<{
    kind: "skill" | "mcp" | "app" | "tool" | "knowledge";
    token: string;
  }>;
  contextRefs: Array<{
    slotId: string;
    kind: SceneContextKind;
    refToken: string;
    versionToken?: string;
  }>;
};
```

Runtime Contract 的 Application 部分只能包含服务端定义的闭集枚举、数字、布尔值和服务端签发的 opaque handle。`capabilityHandles.token`、`refToken` 和 `versionToken` 都不能是 capability slug、skill path、文件路径、URL、标题、外部 revision/ETag 或资源名。不得包含 label、文件名、Brief、用户文本、Plugin/MCP 描述或其他外部可控内容，避免将不可信文本提升为 developer 权限。实际 capability ID、附件、URI、revision 和内容继续通过内部 resolver state、正常 UserInput、typed mention 或 Untrusted context 传递。

`refToken` 绑定当前用户与 draft/thread scope，只用于关联 typed input，不代表已授权；Resolver 在每轮使用前重新检查资源权限、连接状态和 revision，过期或越权 token 返回明确错误。

限制必须由 app-server 校验：最多 32 个 capability handles、24 个 context refs、单个 opaque token 最多 128 字符且只允许受控字符；JSON 最多 4 KiB，同时估算不超过 768 tokens。超限返回 invalid request，不得静默截断 JSON。

### 3.5 Built-in Scene Registry v1

以下是 v1 的 canonical registry，不由前后端各自补默认值。三个 Scene 均为 `presetVersion=1`、`instructionVersion=1`、`defaultMode=auto`；auto 使用 `conversation + read-only + draft-only + common.minimal-clarification`。用户未设置本地权限时，office/design 推荐 `on-request`，code 推荐 `auto-local`。

| sceneId | labelKey / subtitleKey / placeholderKey | defaultDeliverable | recommendedPermission |
| --- | --- | --- | --- |
| office | `scene.office.label` / `scene.office.subtitle` / `scene.office.placeholder` | document | on-request |
| code | `scene.code.label` / `scene.code.subtitle` / `scene.code.placeholder` | code-change | auto-local |
| design | `scene.design.label` / `scene.design.subtitle` / `scene.design.placeholder` | design-directions | on-request |

Context slots：

| Scene | slotId | accepts | maxItems |
| --- | --- | --- | --- |
| office | `office-sources` | document/file/thread/knowledge/web-page | 12 |
| office | `office-people-time` | contact/calendar/date-range | 12 |
| office | `office-coordination-target` | contact/calendar/document/knowledge | 8 |
| code | `code-workspace` | workspace/repository/branch | 3 |
| code | `code-targets` | file/issue/pull-request/log | 16 |
| code | `code-evidence` | issue/pull-request/log/web-page | 12 |
| design | `design-brief` | brief/document/thread | 4 |
| design | `design-target` | figma-node/image/web-page/file | 8 |
| design | `design-brand` | brand/knowledge/document | 4 |
| design | `design-canvas` | canvas-spec | 2 |

Mode specs：

| Scene.mode | default / allowed deliverable | Local / External | Execution alternatives（满足任一完整 bundle） | completionCheckIds |
| --- | --- | --- | --- | --- |
| `office.organize` | action-list / document, table, action-list, knowledge-entry | workspace-write / draft-only | default: no required；preferred `office.read`, `office.document` | `office.structure`, `office.sources`, `office.action-ownership` |
| `office.write` | document / document, message-draft | workspace-write / draft-only | default: no required；preferred `office.document` | `office.audience`, `office.fact-source`, `office.ready-to-use` |
| `office.analyze` | table / table, document, action-list | workspace-write / draft-only | default: no required；preferred `office.spreadsheet`, `office.read` | `office.method`, `office.sources`, `office.conclusion` |
| `office.coordinate` | action-list / action-list, message-draft, document | workspace-write / confirm-each | draft: no required；real action: resolved target ref + matching `office.calendar` / `office.messaging` / `office.knowledge.write` | `office.external-status`, `office.owner-time`, `office.target-state` |
| `code.ask` | conversation | read-only / draft-only | default: no required；optional `workspace.read` | `code.evidence`, `code.no-unrequested-write` |
| `code.plan` | implementation-plan | read-only / draft-only | default: no required；preferred `workspace.read`, `repo.rules` | `code.plan-scope`, `code.plan-validation`, `code.no-unrequested-write` |
| `code.implement` | code-change | workspace-write / confirm-each | local: `code-workspace` + required all(`workspace.read`, `workspace.write`)；preferred `terminal`, `test.run`, `git.local`, `repo.rules` | `code.rules`, `code.diff`, `code.validation`, `code.user-changes` |
| `code.review` | code-review | read-only / draft-only | local: `code-workspace` + `workspace.read`；remote: `code-targets[pull-request]` + `github.pr.read`；preferred `git.local`, `ci.read` | `code.findings`, `code.evidence`, `code.no-write` |
| `design.explore` | design-directions | workspace-write / draft-only | default: no required；preferred any(`vision.input`, `image.generate`, `design.figma.read`) | `design.direction-difference`, `design.fit`, `design.assumptions` |
| `design.refine` | design-artifact / design-artifact, handoff-spec | workspace-write / confirm-each | figma: `design-target[figma-node]` + `design.figma.write`；image: `design-target[image]` + any(`image.generate`, `workspace.write`)；file/web: `design-target[file/web-page]` + `workspace.write` | `design.system-reuse`, `design.preview`, `design.states` |
| `design.produce` | design-artifact / design-artifact, handoff-spec | workspace-write / confirm-each | figma: `design.figma.write`；image: `image.generate`；local: `workspace.write` | `design.spec`, `design.preview`, `design.accessibility` |
| `design.inspect` | design-review | read-only / draft-only | figma: `design-target[figma-node]` + `design.figma.read`；image: `design-target[image]` + `vision.input`；web: `design-target[web-page]` + `browser.read`；file: `design-target[file]` + `workspace.read` | `design.findings`, `design.states`, `design.no-write` |

Capability tag 是 Registry 稳定元数据，不等于具体产品名。`required all/any` 分别映射到 `SceneCapabilityRequirement.match`；实际 capability ID 由 Resolver 返回。office coordinate 的 connector 只有在用户请求真实动作时升级为 required，纯草稿不阻塞。

Quick actions：

| Scene | quickActionId | mode / deliverable | requested slots | suggested tags |
| --- | --- | --- | --- | --- |
| office | `organize-today` | organize / action-list | office-sources, office-people-time | office.read, office.calendar |
| office | `meeting-materials` | write / document | office-sources, office-people-time | office.document, office.calendar |
| office | `project-report` | write / document | office-sources | office.document, office.read |
| office | `capture-knowledge` | organize / knowledge-entry | office-sources | office.knowledge.write |
| code | `implement-feature` | implement / code-change | code-workspace, code-targets | workspace.read, workspace.write, terminal, test.run |
| code | `fix-bug` | implement / code-change | code-workspace, code-targets, code-evidence | workspace.read, workspace.write, terminal, test.run |
| code | `review-changes` | review / code-review | code-workspace, code-targets | workspace.read, github.pr.read, git.local |
| code | `tests-ci` | implement / code-change | code-workspace, code-evidence | workspace.write, test.run, ci.read |
| design | `explore-directions` | explore / design-directions | design-brief, design-brand | vision.input, image.generate |
| design | `design-page-component` | produce / design-artifact | design-brief, design-target, design-brand, design-canvas | design.figma.write, workspace.write |
| design | `generate-visual-asset` | produce / design-artifact | design-brief, design-brand, design-canvas | image.generate |
| design | `review-handoff` | inspect / design-review | design-target, design-brand | design.figma.read, vision.input |

`ScenePreset.capabilityRecommendations` 由 mode specs 与 quick actions 的 selectors 聚合生成，不再维护第四份手写列表。这些表应生成/驱动 Rust registry fixture、`scene/list` descriptor 和前端类型测试；不能复制粘贴成三份独立常量。

Quick action 的展示与 prompt key 统一为 `scene.quick.<quickActionId>.label` 和 `scene.quick.<quickActionId>.prompt`；服务端只下发 key 与结构化 preset，不把本地化 prompt 提升为可信指令。

## 4. Agent 指令与可信上下文

### 4.1 注入原则

不得使用 `thread/start.developerInstructions` 承载 Scene 指令。当前该字段会覆盖配置层已有 developer instructions，而不是安全追加；这样会破坏项目级规则和恢复语义。

浏览器也不得直接提交可自由编辑的 Application 文本。正确链路是：

1. 客户端只提交类型化的 Scene、mode、deliverable、能力选择和 context refs。
2. app-server 校验字段、版本、数量、字符集和组合合法性。
3. 服务端 Scene Registry 根据 `sceneId + sceneInstructionVersion` 生成平台自有的固定指令。
4. Runtime Resolver 将可用能力转换为真实 Skill 输入、MCP/App mention 或 tool exposure。
5. Core 以 Application context 注入可信场景片段；用户内容保持 UserInput 或 Untrusted context。

注入片段应定义为 `core/context` 中的专用 `SceneContextFragment` / `SceneTaskContextFragment` 并实现 `ContextualUserFragment`，不能把前端生成的任意 JSON 直接包装成 developer message。Scene Registry、解析和校验逻辑优先放在 app-server 或独立小 crate，避免继续扩大 `crewon-core`；core 只保留模型上下文所需的最小 fragment 类型。

使用两个固定 context key，避免稳定身份与可变任务互相覆盖：

- `crewon.scene.v1`：线程级，包含平台生成的 Scene 指令、版本和服务端解析的 execution target/strategy opaque 信息；同一线程不可变。
- `crewon.task.v1`：模型任务级，包含最新 `SceneRuntimeContract`、单调递增 `contractRevision` 和 `supersedesContractRevision`；selection-only 变化不进入该片段。

现有 AdditionalContext merge 是完整 snapshot 语义：每次更新都要从当前完整 store snapshot 开始，只 upsert `crewon.scene.v1` 和 `crewon.task.v1`，并把其他功能已有的 key 原样保留；不能只提交 `{scene, task}`，否则未提交的其他 key 会从 store 中被移除。merge 只把值发生变化的项追加给模型。

不创建无限增长的 `crewon.task.<revision>` key。恢复、压缩和 fork 后，服务端必须从持久化元数据重新生成当前 scene 片段与最新 task 片段；不得重写旧历史。

若非空 Scene 的已保存 Registry version 无法解析，进入 `scene-version-unavailable` fail-closed：有效合同固定为 `auto + conversation + read-only + draft-only`，capability handles 置空，禁止本地/外部写入，并提示用户“在当前版本新建同场景任务”。不得静默套用最新 code/scene 指令。`sceneId=null` 的真正旧线程仍显示 `legacy/general`，沿用旧通用线程语义，但不伪装成三场景之一。

### 4.2 执行主体运行时约束

单 Agent 目标必须同时满足：

- 指令层明确当前主会话由唯一执行 Agent 完成。
- Runtime 层关闭 multi-agent capability，并从本轮 tool inventory 中移除 spawn、list、send、interrupt 等多 Agent 工具。

小队目标必须同时满足：

- 小队定义、成员与权限由服务端资源目录解析，客户端不能内联定义。
- Runtime 只开放有界的 spawn/list/send/interrupt 能力，并限制并发、子任务数、上下文与返回大小。
- 主 Agent 保留最终回复、审批、取消和结果收敛权，子 Agent 不直接改写主会话历史。

只写“不要创建子 Agent”不构成单 Agent 保证；只在 UI 选择“小队”也不构成 Team 保证。最终策略和 tool policy 必须来自服务端 Execution Target Resolver，不通过 Scene 隐式触发。

### 4.3 所有场景共享的基础指令

以下内容由服务端静态 Registry 提供，不接受用户、文件、Plugin 或 MCP 描述插值：

```text
你是当前主会话的主 Agent，按照服务端解析的 executionStrategy 执行。
当 executionStrategy 为 single 时亲自完成任务，不创建或委派子 Agent；为 team 时只使用已解析的小队和有界委派能力，并负责结果收敛。
遵守工作区规则、用户约束、localWritePolicy 和 externalActionPolicy。
只把已解析且已授权的能力视为可用；推荐但未激活的能力不能被声称已使用。
外部发送、共享写入、发布、推送、覆盖或破坏性操作必须经过 Runtime Gate。
最终回复说明：完成了什么、产物在哪里、验证了什么、哪些动作未执行或仍需确认。
```

### 4.4 场景 × mode 的行为约束

mode 的约束优先于场景的一般完成目标：

- `code.ask / code.plan / code.review`：只读，不修改工作区；`code.review` 只有用户明确要求修复时才切到新的 `code.implement` 任务。
- `code.implement`：允许工作区写入并要求执行适用验证；提交、推送和 PR 仍是外部 Gate。
- `design.inspect`：只诊断；要改设计必须切到 `refine` 或 `produce`。
- `office.coordinate`：可以准备外部动作，但每个发送、邀请或共享写入都要确认。
- 其他办公 mode 默认生成本地成果或草稿；不会因为 Scene 是 office 就自动发送。

默认 mode 为 `auto`。Resolver 根据明确动词、快捷任务和交付物选择具体 mode，并在 Composer 中展示；低置信度时保留 `auto`，强制使用 `read-only + draft-only` 进入首轮澄清，解析出具体 mode 后再增加 contract revision，不静默选择可写 mode。

### 4.5 三个场景的固定指令

日常办公：

```text
当前场景为日常办公。目标是把分散信息转成可直接使用的办公成果，而不是只提供泛泛建议。
先识别受众、时间范围、信息来源和目标输出；缺少非阻塞信息时使用明确假设继续。
涉及事实、日期、人员或数字时标注来源或不确定性。
优先产出文档、表格、行动项、消息草稿或知识条目。
完成前检查结构、事实来源、负责人和截止时间，并区分“已生成草稿”与“已实际执行”。
```

生码：

```text
当前场景为生码。先读取适用的 AGENTS.md、仓库约束、工作树和相关实现。
按当前 mode 执行：ask/plan/review 保持只读，implement 才允许修改文件。
实现任务应保持改动范围最小，避免覆盖用户已有改动，并运行仓库规定的格式化、测试和静态检查。
不能运行验证时说明具体原因。最终结果列出修改文件、行为变化、验证命令、结果和剩余风险。
```

设计创意：

```text
当前场景为设计创意。目标是从 Brief、品牌约束和参考内容产出可预览、可比较或可交付的设计结果。
先识别目标用户、使用场景、品牌约束、平台和交付规格。
探索类任务生成 2–3 个真正有差异的方向；制作类任务优先生成实际视觉产物。
参考现有设计系统时复用组件和变量。完成前检查层级、状态、响应式、可访问性和交付规格。
无法使用视觉能力时明确降级为线框、结构说明或可执行制作规格。
```

设计创意的 MVP 边界是产品/视觉/品牌相关创作。页面微文案可随设计产物一起完成；独立长文、汇报或营销文章默认归入日常办公，避免两个场景以“写文案”重叠。

## 5. 三场景产品差异

### 5.1 场景判定规则

场景按“主要工作对象 + 验证域 + mode 交付物”判定，不按关键词或“是否生成文件”单独判定：

- 业务信息、人、时间、文档、消息、知识库 + 事实/协作验证：日常办公。
- 仓库、代码、Issue/PR、测试、日志 + 代码证据验证：生码；ask/plan/review 不要求 diff，只有 implement 要求。
- Brief、Figma、视觉资产、设计系统、界面体验 + 设计标准验证：设计创意；explore/inspect 不要求最终资产。

跨场景能力可以自由使用。“按 Figma 实现页面”若以仓库 diff 和测试验收属于生码；“读取代码做界面走查”若以设计问题清单验收属于设计创意。执行中若主要工作对象或验证域改变，UI 建议“在新场景中继续”，不得自动改写当前线程 Scene。

### 5.2 首页状态

首页保留统一骨架，使用中性主 Hero“让 CrewON 完成你的工作”，由 Scene 副标题和 Composer 体现差异：

| 项目 | 日常办公 | 生码 | 设计创意 |
| --- | --- | --- | --- |
| Scene 副标题 | 整理、撰写和推进你的工作 | 围绕仓库完成询问、计划、实现与审阅 | 从 Brief 完成探索、制作与走查 |
| 主控制 | 整理 / 撰写 / 分析 / 协同 | 询问 / 计划 / 生码 / 审阅 | 探索 / 收敛 / 制作 / 走查 |
| 初始模式 | 自动，可手动覆盖 | 自动，可手动覆盖 | 自动，可手动覆盖 |
| 核心上下文入口 | 文档、会议、联系人、日期 | 仓库、分支、Issue/PR、文件、日志 | Brief、图片、Figma、品牌、画布规格 |
| 结果入口 | 文档/表格/行动项 | 回答/计划/Review/Diff/测试 | 方向对比/走查/画布/资产/交付说明 |

首页显示独立的「执行主体」选择器，默认值为「CrewON · 单 Agent」，并列出用户已有且真实可用的单 Agent 与小队。选项必须明确标注 `单 Agent` 或 `Team`；不可用目标可以展示禁用态与原因，但不能发送。发送动作统一为“开始任务”，不使用“Agent 小队草稿”。

平台资源库继续负责浏览、创建和管理 Agent/Workflow/小队；首页 Composer 只选择已有定义，不承担创建或成员编排。选择单 Agent 不触发委派；选择小队时，由服务端确认 Team Runtime 后才可触发有界委派。

这是对旧 `desktop-command-home-scene-update` 中“小队 Hero 和小队发送文案”的明确批准偏离，同时保留并重新定义 Agent 控件为中性的执行主体选择器。进入 UI 实现前必须先更新桌面设计产物和 `crewon-design-reference`，否则视觉验收标准相互冲突。当前 `.workspace-pill` 被 CSS 强制隐藏，也必须在新版基线中恢复为可见工作区入口，或以明确的新入口替换。

### 5.3 用户选择与场景默认值

所有由 Scene 或 quick action 管理的 mode、deliverable、capability 和 context selection 都记录 `SelectionOrigin`：

- Scene 切换只替换 `scene-default`。
- 快捷任务设置的能力、mode 和交付物标记为 `quick-action`，再次切换时提示不匹配，不静默删除。
- 用户手动选择的 `user` 项保留；只有能力不可用时显示错误状态。
- 模型、本地权限和执行主体属于用户/工作区选择，不因 Scene 切换而重置。

权限文案使用“自动执行本地操作 / 需要时请求批准”，与现有 `on-failure / on-request` 语义对应，不承诺“每次本地操作都询问”，也不使用容易被理解为自动批准外部动作的“替我审批”。ScenePreset 只提供 `recommendedPermission`，仅在用户从未选择过权限时应用。

现有“完全访问”不作为场景默认，不放在一级 Composer；若产品保留，只能位于带风险说明的高级设置中。即便用户选择完全访问，也不能扩大 `read-only` mode 或绕过 external `draft-only / confirm-each`。

### 5.4 快捷任务与能力面板

快捷任务应用完整 preset，而非只填 prompt：

```ts
type SceneQuickAction = {
  id: string;
  labelKey: string;
  promptKey: string;
  interactionMode: SceneInteractionMode;
  deliverable: SceneDeliverable;
  suggestedCapabilitySelectors: SceneCapabilitySelector[];
  requestedContextSlotIds: string[];
};
```

能力面板按以下顺序显示：

1. 已选择且已激活。
2. 已选择但需要登录、授权、安装或修复。
3. 当前场景推荐。
4. 其他已安装能力。
5. 可安装的推荐 Plugin。

状态至少覆盖：`loading / ready / auth-required / permission-denied / installing / stale / error / unavailable`。场景推荐不等于静默启用；Skill/MCP/App 必须展示真实激活状态。Plugin 只能展示安装或来源关系，不能显示为“将被 Agent 调用”。Resolver 还应校验当前模型是否支持所选能力；不兼容时阻止发送或提供明确降级。

### 5.5 上下文要求与发送前行为

Context chip 必须绑定 kind、服务端签发的 opaque refToken、revision 和权限状态，不只显示“已选 3 个文件”之类摘要。真实 resource ID/URI 和内容按原有 typed input/attachment 链路传入，不复制进可信 Scene Contract。

- `code.implement` 必须有 workspace/repository；`code.review` 必须有本地 workspace/repository 或可读取的 remote pull-request。`ask / plan` 无仓库时仍可继续，但不得声称已检查或修改代码。
- office 缺外部 connector 时生成可复制草稿。
- design 缺 Figma/Image 能力时降级为本地图片、HTML/CSS、线框或交付规格。

不为每次任务强制展示大型预检卡：

- 低风险且上下文足够：直接发送。
- 缺少非阻塞上下文：使用明确假设继续。
- 缺少 required context 或 required capability：发送前用行内错误阻止。
- 预计包含外部写入或高风险动作：Composer 上方显示紧凑风险条；真正执行时仍由 Runtime Gate 再确认。

### 5.6 运行态与布局

禁止展示无法由真实事件支撑的伪进度或固定百分比。只使用模型计划、Tool/MCP 调用、文件变化、验证结果、产物事件和 Approval 请求。没有结构化阶段事件时显示通用真实状态：`分析中 / 使用工具 / 等待确认 / 生成结果 / 已完成`。

场景流程名称只用于预期说明和事件分组，不能让 UI 假装 Agent 已经过了某一步。

布局要求：

- 低高度窗口采用正常文档流和纵向滚动，不把 Hero 绝对定位在屏幕中心。
- Scene 配置 chip 超出一行时折叠为摘要，不挤压 Composer。
- 风险条与发送按钮始终可见且不互相覆盖。
- 宽屏结果区可以双栏；窄屏将“会话 / 结果”提升为一级 Tab，禁止横向溢出。

### 5.7 Artifact Projection 与结果承载

Result Adapter 不应直接猜 transcript 文本。先把真实 turn item、tool event、文件变更和外部资源写入统一 `ArtifactManifest`：

```ts
type ArtifactManifest = {
  version: 1;
  primaryArtifactId?: string;
  primaryPresentation: "document" | "code" | "design" | "conversation";
  artifacts: Array<{
    id: string;
    kind: "file" | "diff" | "test-report" | "image" | "figma-node" | "document" | "table" | "external-draft";
    uri?: string;
    status: "creating" | "ready" | "partial" | "failed" | "stale";
    sourceEventIds: string[];
    verificationEventIds: string[];
  }>;
};
```

一个任务可以有多个产物，Adapter 只决定首要展示方式：

- Document Adapter：文档、表格、行动项、来源和外部动作草稿。
- Code Adapter：changed files、diff、测试、终端和 Git 状态。
- Design Adapter：图片、方向对比、Figma/页面节点、规格和导出资产。
- Conversation fallback：没有可投影产物时显示文本结果，并明确说明未生成实体产物。

ArtifactManifest 是由 append-only turn/tool/artifact events 计算出的可缓存 projection，不是另一份不可回放的真源；resume/fork/rollback 后按对应事件范围重算。UI 必须处理部分失败、文件已删除、资源权限失效、验证过期和可重试状态，不能只支持“成功/无结果”。

Result Workspace 中的按钮不能绕过当前 contract。每个动作先计算：

```ts
type ResultActionPolicy = {
  actionId: string;
  state:
    | "enabled-local"
    | "draft-only"
    | "requires-mode-transition"
    | "requires-confirmation"
    | "disabled";
  targetMode?: SceneInteractionMode;
  reasonCode?: string;
};
```

首发 MVP 不产生 `requires-confirmation` 的真实执行路径；所有 external action 归一为 `draft-only` 或 `disabled`。只有 B2 v1.1 feature flag 开启后，明确支持的 action 才能进入 `requires-confirmation`。

- code ask/plan/review 不显示可直接修改、提交或推送；“应用修复”先选择 `code.implement`，由服务端生成新的 selection/contract revision，再经过 Resolver。
- design inspect 的“修复/写入 Figma”先切 `refine/produce`；explore 的“选择并深化”切到 refine，而不是直接外部写入。
- office organize/write/analyze 只能复制或生成外部草稿；真实发送/创建日程先切 `coordinate` 并经过 Gate。
- Adapter action 必须生成类型化 turn request，重新经过 Scene policy、capability resolution 和 Gate，不能直接调用底层 Tool/MCP。

## 6. 权限与 Runtime Gate

本地权限与外部动作策略是两个独立维度：

| 动作类型 | 示例 | 处理 |
| --- | --- | --- |
| Read | 读取文件、日历、网页、Figma、知识库 | 已授权且 tool policy 允许时执行 |
| Local Write | 新建本地文档、修改工作区代码、生成本地图片 | 由 sandbox + approvalPolicy + localWritePolicy 决定 |
| External Write | 发送消息、改共享日程、写入 Figma、创建 PR | `confirm-each`；Gate 未落地前只生成草稿 |
| Destructive/Publish | 删除、覆盖共享资产、推送、发布、付费批量生成 | 始终明确确认，不能由 Scene 默认值跳过 |

`localWritePolicy` 必须在 A1 就由 Runtime 强制，不等到 B2：

- 有效本地权限取“组织/宿主限制、SceneTaskContract、用户 sandbox/approval”三者的最小权限；Scene 永远不能扩大用户或宿主权限。
- `read-only` mode 强制使用只读 sandbox，并从 tool inventory 移除或在调用前拒绝 `apply_patch`、文件写入及其他已知本地 mutation tool。
- Shell 即使仍可见，也只能在只读 sandbox 中运行；检测到写入请求时在执行前拒绝。
- `workspace-write` 只是允许上限，不代表必须修改，也不能绕过用户的更严格设置。

外部动作采用固定优先级，不能被“自动批准”或历史记忆批准降级：

1. 组织/宿主 deny。
2. `draft-only`：禁止真实调用，只允许生成草稿。
3. Destructive/Publish：每个动作单独确认，不提供“本会话记住”或批量自动批准。
4. `confirm-each` External Write：每次真实调用都确认；现有 `on-failure`、`never` 或 remembered approval 不能满足该确认。
5. 普通 Read/Local Write 才使用现有 sandbox 与 approvalPolicy。

Registry 中的 `confirm-each` 表达该 mode 在 B2 后允许的最高能力；有效 external policy 还要与 rollout feature capability 取最小值。首发 feature capability 固定为 draft-only，因此不会因 contract 写了 confirm-each 就提前开放外部执行。

Gate 是跨所有工具通道的统一 dispatch policy，不只覆盖 MCP：

```ts
type NormalizedToolEffect = {
  scope: "read" | "local-write" | "external-write" | "destructive-publish";
  source: "annotation" | "inferred" | "unknown";
  annotationTrust:
    | "managed-verified"
    | "admin-configured"
    | "self-declared"
    | "not-applicable"
    | "unknown";
};
```

- MCP/App 优先读取现有 tool annotations；mutation 状态通过 connection manager 统一。但 annotation 也是输入而非天然可信：只有 `managed-verified` 或管理员显式配置的来源可以把 effect 降为 Read。第三方/self-declared annotation 可以提升风险，不能降低风险；默认视为 unknown。
- Shell 必须识别 `git push`、`gh pr create`、网络写请求和已知破坏性命令。`draft-only` 下关闭 shell network egress；`confirm-each` 下 approval token 绑定单次命令摘要/hash，执行后失效。
- Browser 的 navigate/read/screenshot 与 type/click/submit 分开分类；`draft-only` 只开放已知只读动作，可能提交、自动保存或改变外部状态的交互一律禁止。`confirm-each` 的批准只绑定一次具体交互。
- 其他 builtin/custom tool 也必须先归一化为 `NormalizedToolEffect` 再 dispatch；无法分类的 route 禁止真实执行，不默认放行。

自定义 MCP 即使伪造 `readOnlyHint=true`，A1 仍按 unknown fail-closed；B2 只有管理员 allowlist 或 one-shot confirmation 后才能执行可能产生影响的调用。

优先复用现有 approval 层和 read-only、destructive、open-world 等提示；Scene 只提供任务意图和默认 policy，不复制一套平行风险系统。

首发 MVP 的硬边界：所有真实 external write 都是 draft-only，所有 local/external destructive 或 publish 动作都 hard-deny；即使用户确认或选择 full-access/never 也不能执行。Stage B2 属于 v1.1 feature-flag 增量，完成跨通道 Gate 后才可把明确支持的动作升级为 one-shot `confirm-each`；永不提供无需确认的自动外部执行。提示词中的“请确认”不能替代工具调用层的强制 Gate。

## 7. 请求、持久化与生命周期

### 7.1 拆分请求设置

不要把 Scene、每轮上下文和可变权限继续塞进一个 `ThreadRuntimeSettings`：

```ts
type ThreadStartSceneSelection = {
  sceneId: SceneProfile;
  expectedPresetVersion?: number;
  executionTarget: ExecutionTargetSelection;
};

type TurnSceneSelection = {
  quickActionId?: string;
  interactionMode: Selected<SceneInteractionMode | "auto">;
  requestedDeliverable?: Selected<SceneDeliverable>;
  capabilitySelections: Array<
    Selected<{
      kind: "skill" | "plugin" | "mcp" | "app" | "tool" | "knowledge";
      id: string;
    }>
  >;
  contextRefs: Array<Selected<SceneRuntimeContract["contextRefs"][number]>>;
};

type ResolvedThreadSceneSettings = {
  sceneId: SceneProfile;
  scenePresetVersion: number;
  sceneInstructionVersion: number;
  executionTarget: ResolvedExecutionTarget;
  executionStrategy: "single" | "team";
};

type ResolvedTurnSceneSettings = SceneRuntimeContract & {
  contractRevision: number;
  supersedesContractRevision: number | null;
  selectionRevision: number;
};

type PersistedSceneSelectionState = {
  selectionRevision: number;
  supersedesSelectionRevision: number | null;
  quickActionId?: string;
  interactionMode: Selected<SceneInteractionMode | "auto">;
  deliverable: Selected<SceneDeliverable>;
  capabilitySelections: TurnSceneSelection["capabilitySelections"];
  contextRefs: TurnSceneSelection["contextRefs"];
};

type MutableRuntimeSettings = {
  model?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandboxMode?: SandboxMode | null;
};
```

前端概念类型仍叫 `SceneProfile`，wire 和持久化字段统一叫 `sceneId`；不要同时新增 `sceneProfile` 与 `sceneId` 两套协议字段。

客户端只拥有“请求选择权”：选择 Scene、执行主体、请求 mode/deliverable、选择能力和 server-issued context ref。`scenePresetVersion`、`sceneInstructionVersion`、`executionStrategy`、execution target token、contract/selection revision、写入策略和最终 collaborationMode 均由服务端解析并返回；客户端不能用旧版本号、目标 ID 或伪造 revision 降级策略。`SelectionOrigin` 仅用于 UI 行为和审计，不能授予能力。

服务端将有界 `PersistedSceneSelectionState` 与 resolved contract 分开保存：selection state 用于恢复用户看到的来源和 quick action，允许包含经校验的 capability ID；它不进入 Application developer context。resolved contract 只包含闭集 policy 与 opaque handles。

Selection state 继续受 32 个 capability、24 个 context 和 128 字符 ID 上限约束；不持久化展示 label、用户 prompt 或外部描述，恢复时从资源目录重新解析展示信息。

`thread/started` 返回 `ResolvedThreadSceneSettings`；`turn/started` 返回本轮 `ResolvedTurnSceneSettings` 和 selection state，`thread/read` 返回当前有效版本。UI 可以短暂显示“解析中”，但只有收到服务端确认后才能把 mode、能力和 Gate 标为“将使用/已激活”；请求与解析结果不同时展示具体降级原因。

三场景链路中的客户端不得发送 `developerInstructions` 或原始 Application context 文本。app-server 接收类型化字段，运行 Resolver 后在内部构造可信 context。真实 Skill、MCP/App 和资源引用继续走现有结构化输入通道。

### 7.2 Scene Registry 同步

Runtime 语义以服务端 Scene Registry 为唯一真源，前端不得手写另一份独立的 mode/requirement/policy。app-server v2 提供可缓存的 `scene/list` descriptor，至少返回 sceneId、preset/instruction version、mode IDs、context slot IDs、能力 selector 和 i18n copy keys；固定指令正文不下发。

新 list API 按 v2 约定使用 cursor/limit，并返回 `data + nextCursor`。客户端可内置同版本 fallback 用于离线展示，但发送前必须完成服务端 handshake。`expectedPresetVersion` 只做兼容检查，不授予版本选择权；不一致时服务端返回可识别的 version-mismatch，客户端刷新 descriptor 并保留草稿，不静默用 UI V2 + Runtime V1 执行。

首版 API 统一标记为 experimental capability `sceneRuntime`：`scene/list`、thread/turn params 中的 Scene 字段、resolved response 字段和通知均使用对应 `#[experimental("sceneRuntime")]` 门控；只有部分 params 字段为 experimental 的 method 在 `common.rs` 开启 `inspect_params: true` 并派生需要的 `ExperimentalApi`。稳定性与兼容承诺在完成首发 telemetry 和恢复兼容验证后再单独评审，不由实现者自行决定。

### 7.3 app-server v2 与持久化

完整 MVP 必须持久化 Scene，不能只放前端 state 或 localStorage。API 边界使用稳定 String ID，v1 只允许 `office / code / design`；服务端 Scene Registry 再映射到闭集语义。

`ThreadStartParams` 中新增的 optional 字段使用 `#[ts(optional = nullable)]`；v2 response 中对应 `Option` 字段始终序列化为值或 `null`，不使用 `skip_serializing_if`。wire name 保持 camelCase。

线程元数据至少保存：

- `sceneId`
- `scenePresetVersion`
- `sceneInstructionVersion`
- `executionStrategy`
- 当前有效 contract、selection state 的 server-owned revision 与有界 cache

selection 与 resolved contract 分别追加事件，metadata 中的“latest”只能是索引/cache，不是唯一真源：

```ts
type SceneSelectionChanged = {
  type: "scene-selection-changed";
  turnId: string;
  state: PersistedSceneSelectionState;
};

type SceneContractChanged = {
  type: "scene-contract-changed";
  turnId: string;
  contractRevision: number;
  supersedesContractRevision: number | null;
  selectionRevision: number;
  contract: SceneRuntimeContract;
};
```

仅 origin、quickActionId 或其他 UI selection 改变、但 resolved contract 相同时，只追加 `SceneSelectionChanged`，不增加 contractRevision、不注入新的 Application fragment。rollback 时从保留下来的两类事件重算当前 selection 与 contract；fork-at-turn 继承 fork 点之前最后一个有效事件，而不是源线程此刻的 latest cache。“在新场景中继续”则创建新的 scene identity，不复制旧 scene fragment。

已发布的 preset/instruction version 必须不可变；文案、完成标准、默认能力或权限语义改变时递增版本。Registry 至少保留仍可能被恢复的旧版本，不能在相同版本号下替换内容。

`thread/start`、`thread/started`、`thread/list`、`thread/read`、`thread/resume`、fork、rollback/unarchive、ephemeral thread 和 remote thread store 必须使用同一语义。持久化实现需要覆盖 SessionMeta、state DB ThreadMetadata、rollout metadata extraction、所有 Thread 构造路径和通知 payload，避免只改主路径。同步更新 app-server README、稳定/实验 schema fixtures 和生成的 TypeScript。

旧线程的 Scene 为 `null`，客户端显示“通用/历史任务”；不按 code 兼容注入新指令。普通 fork 继承 fork 点的 Scene、版本和有效 contract；“在新场景中继续”显式创建新线程，只传递有界摘要或产物引用。

### 7.4 恢复与缓存规则

- 新线程第一轮注入 scene 与 task 片段。
- 后续更新在完整 AdditionalContext snapshot 上 upsert scene/task；同值项由 store 去重，不重复注入，避免无意义 cache miss。
- 服务端先比较 selection state；变化时递增 selectionRevision 并追加 `SceneSelectionChanged`。再比较 resolved contract；只有模型可见合同变化时才递增 contractRevision、设置 `supersedesContractRevision` 并追加 `SceneContractChanged` 与新的有界片段。
- 旧 contract 片段保留在历史中，但模型以最新 superseding contractRevision 为准；selection-only 变化不造成 developer context cache miss。
- resume 时若重建的模型上下文已包含最新 fragment，先用持久化 snapshot seed `AdditionalContextStore` 而不再次发射；若 compact 后当前模型上下文不含 fragment，则只重新注入最新有效版本一次。
- fork 从 fork 点的两类有效事件与 snapshot 恢复；rollback 从回滚后仍存在的事件恢复，并同步重建 store，不能保留被回滚 contract/selection revision。
- 不删除、改写或回填旧用户消息。
- 单个 injected fragment 不超过 1K tokens，本规范进一步限制为 768 tokens；所有列表有硬上限。

### 7.5 Scene 切换

- 空白新任务：立即切换 ScenePreset。
- 有草稿：保留正文、附件和用户选择；重新计算 `scene-default`，标记不兼容项。
- 已创建线程：Scene 固定。
- 需要换 Scene：显式“在新场景中继续”，新线程记录来源 thread/artifact ref。
- 空白新任务或未发送草稿：可以切换执行主体，且不改变 Scene。
- 已创建线程：执行主体及解析后的 `executionStrategy` 固定；不得在同一历史中途替换 Agent 定义或 Team 成员。
- 需要换执行主体：显式“由其他执行主体继续”，新线程只继承来源 thread 的有界摘要和 artifact refs，并重新执行目标授权与能力解析。

## 8. 缺失能力、降级与错误状态

每个 Scene 在 Plugin/MCP 缺失时仍能提供诚实的最小能力：

- 日常办公缺 Calendar/Email：生成会议方案、邀请或消息草稿，不声称已发送。
- 生码缺 GitHub：仍可处理本地仓库，不声称已推送或创建 PR。
- 设计创意缺 Figma：生成本地图片、HTML/CSS、线框或设计规格，不声称已写入 Figma。
- 缺 Image Generation：提供方向、布局、组件和可执行视觉规格。

没有 execution alternative 满足全部 required context/capability 时阻止发送；`preferred` 缺失时展示降级说明；`optional` 缺失不阻塞。错误信息必须给出下一步，例如登录、授权、安装、重新连接、移除能力或采用降级方案。

## 9. 可评审实施拆分

### Stage D0：设计真源迁移（进入 UI 开发前置）

- 更新桌面设计产物和 `crewon-design-reference`，移除当前首页的小队 Hero 和小队发送文案，将 Agent selector 重构为默认 CrewON、可选已有 Agent/小队的执行主体选择器。
- 恢复或替换当前被隐藏的工作区入口，补齐低高度和窄屏布局。
- 明确 Scene 与执行主体切换互不覆盖，并覆盖目标不可用、授权缺失和 Team Runtime 未启用状态。
- 完成设计评审并将新产物设为唯一 UI 验收基线；D0 未完成时不得开始 A0 页面代码或用旧 Skill 验收。

### Stage A0：Scene UI Domain

- 解耦 `CommandScene` 与现有 `WorkMode`。
- 建立 ScenePreset、mode、deliverable、context slot、selection origin。
- 完成首页、Composer、能力分组和低高度/窄屏快照；此阶段只使用 schema-compatible mock descriptor 并置于 feature flag 后，不得生产发送或声称能力已激活。

### Stage A1：可信 Runtime Contract 与执行主体解析

- 新增服务端 Scene Registry 和 contract validator。
- 提供 `scene/list` descriptor/版本 handshake，前端从服务端同步 Runtime 语义。
- 增加 Execution Target Resolver：验证 CrewON/Agent/Team 定义与授权，返回 opaque target token 和 server-owned `single/team` 策略。
- 增加有硬上限的专用 ContextualUserFragment，通过可信 Application context 注入固定 scene/task 片段，不使用 `developerInstructions`。
- 先落跨通道 fail-closed guard：Shell network egress 关闭；Browser 只开放已知只读动作；MCP/App/builtin 中 external mutation、local destructive 和 effect unknown 的工具不暴露或调用前拒绝。
- 将用户显式选择、且已有稳定 ID 的能力接入真实 Skill/MCP/App inputs；本阶段不做推荐发现与安装状态编排。
- 对 CrewON 与单 Agent 关闭 multi-agent runtime；对可用小队仅开放有界 Team 工具，并分别验证 model tool inventory。
- 将 Scene localWritePolicy 与用户/宿主 policy 取最小权限；read-only mode 强制只读 sandbox 并拒绝本地 mutation tools。
- 增加模型可见上下文的集成测试。

### Stage A2：Scene 持久化与线程生命周期

- app-server v2 增加 Scene 元数据。
- 覆盖 start/list/read/resume/fork/rollback/unarchive/remote/ephemeral。
- 将 selection 与 resolved contract 分别写成 append-only `SceneSelectionChanged` / `SceneContractChanged`，latest metadata 只作 cache；支持 fork-at-turn 与 rollback 重算。
- 更新 README、schema fixtures 和生成类型。
- 验证 resume/compact/fork 的再注入、legacy/general 和 scene-version-unavailable fail-closed。

### Stage B1：Capability Resolver

- 稳定 ID/tag 推荐、availability、activation、模型兼容性。
- 补齐 Quick action 推荐、自动发现、授权/安装状态与模型兼容性，并复用 A1 的 typed input 映射。
- Plugin 只做安装与 provenance；完成 required/preferred/optional 降级。
- MCP 能力与 tool inventory 的增量变化优先收敛在 `crewon-mcp/src/connection_manager.rs`，避免跨层重复维护状态。

### Stage C0–C3：Artifact Projection 与结果 Adapter

- C0：从真实事件生成可重算 ArtifactManifest，并覆盖 resume/fork/rollback。
- C1：Document Adapter。
- C2：Code Adapter。
- C3：Design Adapter。

### Stage B2：Runtime Gate（v1.1，非首发 MVP）

- 在统一 tool dispatch 层归一化 MCP/App、Shell、Browser 和 builtin/custom tool effect，再基于 annotations、approval 和 sandbox 强制策略。
- 将 A1 中 external/destructive 的 fail-closed deny，在风险可分类且 policy 允许时升级为 one-shot confirm；未知 route 继续 deny。
- feature flag 开启前外部动作保持 draft-only。
- confirm-each approval 绑定单次 tool call；覆盖 shell/browser 绕过、注解缺失、风险升级、auto/remembered approval 绕过、拒绝和重试。
- MCP tool call 的 mutation 与审批尽量复用 connection manager 和现有 approval abstraction，不另铺一条场景专用调用链。

Stage 是里程碑，不等于单个 PR。至少按下列子 PR 拆分：

- A1.1 Registry + `scene/list` + trusted fragments；A1.2 fail-closed guard + local/single tool policy；A1.3 typed Skill/MCP/App inputs。
- A2.1 protocol/schema + SessionMeta/state/rollout storage；A2.2 start/read/resume/remote；A2.3 fork/rollback/unarchive/ephemeral replay。
- B2.1 normalized effect + MCP/App；B2.2 Shell/Browser/builtin guard；B2.3 one-shot approval、拒绝与重试 UI。

每个复杂子 PR 目标低于 500 行有效逻辑改动，总改动不超过 800 行；超出时继续拆分。D0 是 A0 的硬前置；A0 可以先在 feature flag 下评审，但 A1+A2 完成前不能宣称 Scene 已进入真实 Agent；首发 MVP 始终不开放真实 external write，只有 B2 v1.1 完成并启用 feature flag 后才逐次确认开放。

## 10. 测试要求

### Domain 与前端

- 三个 ScenePreset 和 SceneTaskContract 使用完整对象 equality。
- quick action 应用、SelectionOrigin 保留和 Scene 切换使用完整 state equality。
- 相同输入在三 Scene 下生成不同 contract；非法 scene×mode 组合被拒绝。
- 首页、能力状态、风险条、草稿切换、低高度和窄屏均有 UI snapshot。
- 用户权限不因 Scene 切换改变；Scene 推荐只在未设置时生效。
- 运行态只展示真实事件；ArtifactManifest 支持多产物、partial、failed、stale 和 fallback。
- ResultActionPolicy 按 scene×mode 控制按钮；review/inspect/office draft 不能从 Adapter 直接写入，mode transition 会创建新的 selection/contract revision。

### Core / Agent 集成

- 捕获 outbound `/responses` body，断言 scene fragment 的角色、顺序、版本和内容。
- Application context 中不存在 label、文件名、用户文本、capability slug/path、外部 revision/ETag、Plugin/MCP 描述等不可信字符串；恶意 ID/revision 测试只能看到服务端 opaque token。
- Skill 以真实 Skill input 进入；MCP/App 使用结构化 mention，并与可用 tool inventory 对齐。
- `single` 任务的 tool inventory 不包含多 Agent 工具；`team` 任务只包含策略允许的有界 Team 工具。
- 客户端不能通过伪造 Agent/Team ID、显示名或 `executionStrategy` 开启 Team；不可用目标在服务端阻止发送。
- B2 前的 fail-closed guard 禁止 Shell network egress、Browser mutation、external mutation tool、local destructive 和 unknown-effect route。
- ask/plan/review/inspect 强制只读；即使用户选择 workspace-write/full-access，也不能写文件。implement/produce 仅在 Scene 与用户 policy 都允许时写工作区。
- Scene upsert 保留其他 AdditionalContext key；同值 contract 不重复注入。selection-only 变化只增加 selectionRevision；contract 变化生成正确 `supersedesContractRevision`。
- resume seed store 时不重复发射；compact 后缺失 fragment 时只补最新一次；fork/rollback 不保留未来 contract/selection revision。
- contract 数量、长度、字符集、4 KiB 和 768-token 限制在服务端强制执行。

### app-server v2

- `scene/list` descriptor 使用 cursor/limit，版本与 Registry 一致；expectedPresetVersion mismatch 保留草稿并阻止执行。
- start/started/list/read/resume/fork/rollback/unarchive/remote/ephemeral round-trip Scene 元数据。
- fork-at-turn 与 rollback 根据保留的 `SceneSelectionChanged` / `SceneContractChanged` 事件恢复正确 revision，不读取源线程当前 latest cache。
- mode、deliverable、capability/context 的 `SelectionOrigin` 与 quickActionId 可恢复，且不会进入 Application context。
- 客户端伪造旧 preset/instruction version、executionStrategy 或 revision 不能降级服务端策略。
- legacy thread 返回 null/general，不被错误映射为 code。
- 非空 Scene 的 Registry version 缺失进入 `scene-version-unavailable`，强制 read-only/draft-only、空 capability handles，并引导新建任务。
- 场景字段不覆盖已有 developer instructions，不改变历史增量语义。
- Gate 使用 annotation 的保守回退；Shell push/POST、Browser submit/auto-save、builtin/custom mutation 都不能绕过统一 effect policy。
- 恶意/自定义 MCP 伪造 `readOnlyHint=true` 仍按 self-declared/unknown 处理；只有 managed-verified 或 admin-configured annotation 能降低风险。
- `on-failure`、`never` 和 remembered approval 不能绕过 confirm-each；one-shot approval 不可复用。B2 前 external write 为 draft-only，destructive/publish hard-deny。
- `sceneRuntimeExternalActions` feature flag 关闭时，Registry 的 confirm-each 也被降为 draft-only；开启后仅 allowlisted action 可进入 one-shot confirmation。
- API 变更运行 `just write-app-server-schema` 和 `just write-app-server-schema --experimental`，并执行 `just test -p crewon-app-server-protocol` 与受影响项目测试。

任何用户可见 UI 变化都必须更新并审阅 `insta` snapshot。Agent 逻辑变化优先使用 core integration test，不以纯 instruction snapshot 代替行为测试。

## 11. 完成验收与指标

A0–A2 完成后，可称为“Scene Runtime 基础可用”：

- Scene 真实进入 Agent 请求并可恢复，不是前端标签。
- 默认 CrewON 和单 Agent 由 runtime/tool policy 强制为 `single`；小队由服务端解析为受限 `team`。
- 相同输入在三 Scene 下使用不同 mode、完成标准和上下文结构。
- 不可信文本不会进入 developer 权限上下文。

B1 + C0–C3 完成后，可称为“首发三场景 MVP 可用”：

- 用户看见的能力状态与 Agent 实际可用能力一致。
- required capability 缺失固定阻止；preferred 缺失才明确降级。
- 日常办公、生码、设计创意都有 mode-aware 结果承载。
- 所有 external write 只生成草稿，destructive/publish hard-deny。

B2 v1.1 完成后，明确支持的 external action 才可逐次确认执行；其余继续 draft-only/deny：

- Gate 覆盖 MCP/App、Shell、Browser 和 builtin/custom tool。
- confirm-each approval 绑定单次调用，不被 auto/remembered approval 绕过。

完整产品差异按 mode 验收：

- 日常办公按 mode 产出文档/表格/行动项；首发只展示外部动作草稿，B2 后再显示确认与执行状态。
- 生码的 ask/plan/review 分别以证据化回答、实施计划和可定位发现结束；implement 才以可审阅、可验证的代码改动结束。
- 设计创意的 explore/inspect 分别以方向对比和走查发现结束；refine/produce 才以可预览或可交付的视觉产物结束。

首版埋点至少衡量：Scene 选择/自动判定分布、用户手动改 Scene 或 mode 的比例、required context 缺失率、能力激活成功率、降级率、external-action 草稿/尝试率、实体产物生成率、完成后继续编辑或导出的比例。B2 后再增加 Gate 确认/拒绝率。若用户频繁改 Scene 或 mode，说明分类或默认值仍不可靠。

## 12. Review 结论

本规格解决了当前设计中会阻止落地的五个问题：

1. Scene 不再通过会覆盖项目规则的 `developerInstructions` 注入。
2. 推荐、选择、可用和实际激活被 Runtime Resolver 明确区分。
3. 执行主体由服务端解析；单 Agent 关闭多 Agent 工具，小队只开放有界 Team 工具，而不是只靠提示词或前端选择。
4. 权限按 Scene × mode、local write 和 external action 两个维度执行。
5. 结果先投影为多产物 ArtifactManifest，再由场景 Adapter 展示。

剩余不是产品定义缺口，而是实施前置：先完成 D0 更新旧小队设计基线，再按 A0→A1→A2→B1→C0–C3 完成首发 MVP，B2 作为 v1.1 逐次确认外部动作。若某部署尚未完成 Team Runtime，Team 选项必须诚实禁用，不能回退成伪 Team。任何阶段若跳过对应行为测试，不能以 UI 文案或 prompt snapshot 代替验收。
