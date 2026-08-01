# W3-02LKR Specification: Local Knowledge Retrieval

状态：Discovery 完成；A 波开始实施。本子切片归属 W3-02，复用 W1-07 Typed Context 和 W2-05 Provider Knowledge，不建立第二套 Provider Router。

## 1. 用户结果

CrewON 的知识库以外部 Provider KnowledgeBase 为主要扩展来源，同时把当前工作区文件作为内置本地来源。用户能辨别来源、授权状态和新鲜度；检索结果以有界、不可信数据进入模型，不会自动升级为长期记忆。

## 2. 已确认事实

- `knowledge/list` 当前只枚举本地工作区文件，并把 `.crewon/knowledge.md` 当作人工笔记。
- W2-05 已完成 Provider `KnowledgeBase` 的 catalog、binding 和 bounded `search` 执行链；本切片不得复制该链路。
- W1-07 已定义 `Knowledge` provenance、`UntrustedData` trust、Audience、freshness 和预算。
- Office Memory 与个人 Memory 有不同写入授权和生命周期，不属于 Knowledge source。

## 3. 权威模型

知识源闭集第一版：

- `localWorkspace`：README、AGENTS、项目文档和显式选择的本地目录。
- `providerKnowledgeBase`：通过服务端 Provider Resource Binding 授权的远端知识库。

本地文件或 Provider 是内容权威；本地索引、缓存和 embedding 都只是可重建派生物。Provider 内容默认实时 `search/read`，离线缓存必须携带 revision、content digest、principal、过期时间和 stale 标记。

## 4. 不变量

1. 客户端 `cwd`、Provider URL、resource revision 和 Credential 不能成为最终授权依据。
2. Provider Knowledge 只走 W2-05 的 exact binding 与 `search` 路由。
3. Knowledge 输出固定为 `UntrustedData`，不得进入 system/developer role。
4. 单 fragment、总 token、结果数和源文件大小必须有硬上限。
5. 外部知识不得自动写入个人 Memory 或 Office Memory；跨域提升必须显式、可预览、可审计、可撤回。
6. Office Memory、Thread Rollout、compaction、checkpoint、Artifact 和 Evidence 保持独立权威。
7. 远端失败不能回退到未授权来源；本地来源可以独立可用。

## 5. 读取链路

1. 服务端从 RequestIdentity 和 Workspace Binding 确定 audience。
2. Source Catalog 合并本地来源与已绑定 Provider KnowledgeBase。
3. Query Broker 对允许的来源执行本地 lexical/FTS 或 W2-05 Provider search。
4. 结果统一映射为 W1-07 Governed Context fragment。
5. 服务端生成 retrieval manifest、来源 revision、命中原因和 citation handle。
6. UI 展示来源、状态、新鲜度和引用；模型不能伪造已使用来源。

## 6. 写入边界

- `.crewon/knowledge.md` 是显式人工工作区笔记，不是自动记忆。
- 模型建议先进入候选区，未经确认不得修改共享知识文件。
- Provider 数据保持在 Provider；本地只保存授权元数据和可删除缓存。
- Office candidate 继续通过 `office/memory/decide` 审核。

## 7. 分阶段交付

### A. 本地基线与契约

- 加固 `.crewon/knowledge.md` 写入的大小和原子性边界。
- 在不切流的前提下冻结 source origin、状态和 retrieval manifest 契约。

### B. Source Catalog

- `knowledge/list` 明确返回 local/provider origin。
- 从 canonical Provider Resource Binding 投影远端 KnowledgeBase，不直接调用旧 Agent Platform catalog。

### C. Governed Retrieval

- 本地文件增加有界 lexical/FTS 检索。
- Provider 查询复用 W2-05 `search`。
- 两类结果统一进入 W1-07 bundle，并生成服务端 citation。

### D. 产品收敛

- Knowledge UI 改为知识源中心；`.crewon/knowledge.md` 仅作为本地来源之一。
- 移除“知识记忆/重置全局记忆”的混合表述。
- 旧 `knowledge/memory/write` 进入兼容期，后续替换为显式候选/应用 API。

## 8. 非目标

- 新建 Provider catalog、binding、Credential 或 dynamic execution 协议。
- 在本切片引入云端 embedding 依赖。
- 把 Office Memory 合并进 Knowledge 页面或通用写 API。
- 允许 Cloud Agent 隐式读取本地知识；该能力等待 W6 Context Export Gate。
- 在 A 波修改 `platform_control`、中心 `message_processor` 或前端组合文件。

## 9. 验收与停止条件

- A 波 targeted tests 证明写入有界、重复写保留既有内容、失败不产生部分文件。
- B/C 波必须覆盖跨 workspace、principal/revoke、revision drift、过期和无相关结果。
- 任何实现若需要第二套 Provider Router、客户端权威或 developer-role Knowledge，立即停止并修订 spec。
