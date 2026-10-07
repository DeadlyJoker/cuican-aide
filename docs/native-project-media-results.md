# 桌面媒体结果保存与读取

2026-10-07。接续[媒体候选目录](./project-media-result-catalog.md)。原 Desktop Native 启动入口现在可以显式装配目录、原任务结果保存及已冻结图片读取。这里的保存是将原供应商输出记录为项目候选；不发布到外部平台、不标记为已采用，也不发起新的生成。

## 启动声明与兼容边界

在原 v3 Bootstrap 的 `projects` 中增加可选声明，并由原批准文件匹配同一份声明：

```json
{
  "mediaResults": {
    "version": "crewon.desktop-project-media-results.v1",
    "purposes": ["read", "publish"],
    "publications": [
      {
        "pluginId": "crewon.short-drama",
        "packageDigest": "sha256:<实际批准包的摘要>",
        "contributionId": "workbench"
      }
    ]
  }
}
```

`read` 必须存在；`publish` 可选。每个包必须存在于批准的 publication 与原 `mediaInputs.reviews`；保存新结果还要求同一包的 `mediaGenerations` 声明。仅批准媒体输入、生成或普通项目读取，不会隐式开放结果路由。

纯读取启动校验已有结果 schema，不执行迁移，不取得新生成准入。显式保存启动通过原 Core 准备原 operation 和结果存储。这个声明由 Native 结果模块消费，不传入普通项目元数据配置。Bootstrap、批准文件、原 profile 与 Native owner 在请求和事务期间持续核验；批准文件身份变化后读取也会失效。

这是增量配置和 HTTP 能力：原目录 DTO/路由、结果记录格式与 SDK UI ABI 不变；旧配置省略字段时行为不变。旧宿主不支持该新声明，部署时需要使用包含此装配的新宿主版本。没有修改原任务、积分、事件和普通会话协议，也没有自动更新用户已打开的 App 或完整插件包。

## 原身份与图片读取

`InstalledProjectMediaResultRuntime` 只能借用真正签发且仍活跃的原 Core。每次操作保留真实请求身份、profile、项目和原 Run/结果序号，并分别检查目录、读取、保存权限。历史操作采用原 request owner 的配置读取模式，不调用执行 peer 的 catalog、readiness 或生成准备；关闭此结果模块会取消并等待自己的物理操作，不关闭借用的 Core。

首次保存从已验证的原 operation 解析输出，调用当前批准的同一服务 `GET /view`。批准检查在 DNS 前、实际 GET 前、冻结前执行；不接受客户端提供的地址。已有冻结候选直接重放，不重新访问供应商。读取始终验证原项目和任务来源、加密文件、长度、PNG 格式与摘要。缺失、损坏或来源不一致时报错，不以重新生成或替换文件掩盖问题。

结果归档使用原宿主配置的主密钥，通过独立派生域生成结果密钥，并按 tenant/space/profile 保存到独立目录；与上传参考素材的路径和密钥分离。密钥与供应商地址不进入公开 DTO、插件或浏览器。

## HTTP 与原客户端

所有路由都使用原身份和来源检查；响应禁止缓存。POST 要求原 CSRF，不接受业务参数、供应商地址或客户端权限声明。

| 方法 | 路径                                                                             | 行为                                               |
| ---- | -------------------------------------------------------------------------------- | -------------------------------------------------- |
| GET  | `/api/v1/creative-projects/:projectId/media-results`                             | 原分页目录，最多 16 条                             |
| POST | `/api/v1/creative-projects/:projectId/media-results/:runId/:resultIndex`         | 用 `{}` 保存原任务位置对应的候选，重复请求返回原件 |
| GET  | `/api/v1/creative-projects/:projectId/media-results/:runId/:resultIndex`         | 校验冻结图片后返回元数据；尚未保存时返回 null      |
| GET  | `/api/v1/creative-projects/:projectId/media-results/:runId/:resultIndex/content` | 返回已校验的 PNG，未保存时返回 404                 |

`ControlApiClient.projectMediaResults` 提供 `listCandidates`、`publish`、`getCandidate`、`readContent`。沿用原认证、来源、取消和手动重定向策略，不自动重试。图片客户端核对候选 ID、媒体类型、长度及完整 SHA-256，再返回字节；取消时丢弃部分内容并关闭响应流。

## 本次证据与剩余范围

证据目录：`output/extensions/checks/native-media-results-20261007/`。新增及关联回归共 77 项通过，无跳过，包括：

- 真正安装的 Short21 T10/D18 handler、原 Run/operation、SQLite 与 PostgreSQL、真实加密归档、原认证 HTTP/Control Client。
- 首次保存、重复保存、精确原位置、PNG 字节、只读 Core 冷恢复、拒绝外部授权变化、跨身份/profile、关闭等待和上游素材未被采用。
- 真正文件签发的 Native 启动、原 standalone `buildControlApi` 路由装配、声明缺省、批准文件更换、冷重开，以及结果/上传素材密钥隔离。
- 原目录与 publisher 回归、客户端损坏/超长/短流/重定向拒绝、取消清理和旧配置兼容。

供应商 DNS、网络响应和部分授权策略仍为具名测试夹具；本次未调用用户外部 ComfyUI。Native 文件启动验证的是装配、目录和授权；完整的任务输出到字节读取由原 Core/实际 handler 测试覆盖，不能据此声称完成了真实外部服务、桌面 UI 或模型自动执行验收。

插件页面尚需接入候选预览与明确“采用”；Agent 工具、自动执行和后续视频/声音/成片仍在完整目标内。本次不改页面、主题和公共导航。后续 UI 继续遵守[插件可变范围](./plugin-variability-boundary.md)，只在短剧内容插槽呈现这些能力。
