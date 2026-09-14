# F01 上传传输限额证据

2026-09-14，Node v24.19.0，当前 feature worktree。以下是实际传输检查，不包含模型执行或 Electron GUI 点击。

`packages/domain/src/delivery-http-policy.ts` 是 Web BFF、桌面 renderer 与 Electron host 共用的纯限额策略。仅 POST `/api/v1/threads/<合法opaque ID>/delivery/inputs` 且无 query/hash 获得 `ceil(10 MiB × 4 / 3) + 4096 = 13985110` 字节的 JSON 上限。请求不携带可自定的额度。编码后的 thread ID 解析后必须符合既有 ID 字符限制，编码斜线和二次编码拒绝特殊额度。鉴权仍由现有 session/CSRF/thread 路径执行。

- Web BFF handler 与真实 HTTP listener 都使用同一策略，读取流时逐 chunk 计数，最多保留允许的字节和 4096 个片段；不先 arrayBuffer 再检查。超限 handler 取消输入流；listener 停止保留字节并回复 413，随后丢弃未读字节以便客户端收到响应，既有 30 秒 requestTimeout 约束未完成发送者。普通请求仍为 64 KiB。
- 桌面 renderer 准备上传 body 与 host 入口分别重验相同上限。其它请求仍为 2 MiB；全局 16 MiB 请求字节预算、请求数量、读配额及恢复/取消语义保持。13 MiB 占用期间另一 4 MiB 请求被拒绝；renderer 失败释放本地预算，host 等真实握手结束后才释放原生占用。
- nginx 只新增交付上传 regex location；要求 POST、无 query，采用同一数字上限，关闭 request buffering。既有两个 API location 的 64k 配置保持。BFF 容器复制 domain 源码到真实 workspace 路径，通过 node_modules 符号链接加载纯 subpath，避免 Node 拒绝直接位于 node_modules 内的 TypeScript。

实际检查：

| 检查                                                | 结果                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Domain 精确路径策略测试                             | 1/1；合法ID、编码ID、错误方法、尾斜线、query/hash、编码斜线与错误路径                                         |
| `pnpm --filter @crewon/web-bff test`                | 20/20；10 MiB CSV 的完整 Base64 JSON、逐流超限立即取消、真实 HTTP 成功/413、session/CSRF、SSE原检查、部署路径 |
| 桌面 `desktopFetch.test.ts` + `desktopHttp.test.ts` | 36/36；大文件请求原字节、边界上限、错误路由、共享16 MiB预算与失败/取消释放                                    |
| `pnpm --filter @crewon/web-bff typecheck`           | 通过                                                                                                          |
| `pnpm --filter @crewon/ui lint`                     | UI 类型与 Electron host 类型通过                                                                              |
| `pnpm crewon:boundary:check`                        | 通过                                                                                                          |
| `pnpm format`                                       | 通过                                                                                                          |
| BFF 镜像目录布局                                    | 临时真实目录复制、符号链接、独立 Node 子进程导入共享策略通过                                                  |

当前机器没有可执行的 nginx，Docker CLI 可用但 daemon 未运行；未声称执行 nginx `-t` 或构建/运行容器。nginx 配置的路径/方法/query/额度检查和 Docker 目录布局实际 Node 导入检查已完成，容器部署仍需部署环境验收。
