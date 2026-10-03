# 已安装短剧包的本机浏览器预览

使用原 `ShortDramaPluginPreview` 宿主外框，通过正式 `useInstalledPluginModules`、ControlApiClient、InstalledPluginModule 和 TrustedPluginUiLoader 原生动态 import 加载实际独立包。不直接导入短剧业务组件，也不替换首页、账号栏、设置页或全局样式。原 5719 预览不变。

```sh
node artifacts/installed-short-drama-preview/preview-server.ts /absolute/prebuilt/short-drama/1.0.0 5720
```

Node.js 24 启动时将指定预构建目录通过真实 `installLocalPluginPackage` 复制到任务自己的临时安装根，再使用实际 SQLite 安装账本记录并启用 `crewon.short-drama`。明确只允许示例发布者的 UI-only v1 包。真实 LocalPluginUiPackageReader 在每次资产读取前后核验字节摘要，仅批准 `ui.mjs` 和清单 PNG；许可与元数据文件不会默认公开。

Vite 与私有随机端口 Fastify 均仅监听 `127.0.0.1`。同源代理复用实际 `registerPluginControlRoutes` 的 UI 路由与 `StandaloneIdentity` 的 Origin/CSRF 校验，没有新增安装/启用 HTTP 接口。renderer 从原 `/control-api/session` 格式读取 `baseUrl` 与 CSRF token；随机 Bearer 仅在服务端代理中注入，不返回给 renderer 或写入日志。代理注入前拒绝非 loopback、外国 Origin、cross-site 和非指定 Host 请求。Actor/profile 是具名本机预览夹具，不是登录用户或生产鉴权策略；账号栏继续显示“未登录 / 页面预览”。所有 invoke 授权拒绝，没有生成服务、Run、充值或收费接线。

Vite 开发服务器会给 `@vite-ignore` 原生动态 import 注入空 `?import` 标记。这个开发代理仅对实际 mount 资产路径移除精确 `?import`；不改字节、不替换 importer、不修改正式空查询契约。`?import=value`、附加查询及其他查询继续交由正式路由拒绝。生产构建不依赖这个开发标记。

入口在 `/`，使用原桌面外观查询参数。点击原侧栏“AI 短剧”加载安装产物；进入账号设置时插件卸载，返回后重挂并重置演示数据。正式主题投影继续只更新插件拥有的节点。`/__installed-short-drama-proof` 提供此夹具的已安装身份、实际资产读取次数、挂载数与零 Run/消息/积分表证据，只有具名 loopback 预览可读，不是生产管理 API。

运行 `node artifacts/installed-short-drama-preview/preview-http-proof.ts` 可验证真实 ControlClient 会话、目录、挂载、JS/PNG 字节摘要和关闭，以及 CSRF/跨站/私有资产/生成拒绝。它会创建并关闭自己的 UI mount，不执行插件浏览器代码，不证明页面视觉或交互验收，也不输出任何 token。结果写入 `output/extensions/checks/installed-short-drama-preview-http-20261003.json`。隐藏的 `data-installed-preview-diagnostics` 输出仅保留正式 UI hook 最近 8 KiB 的错误文本，便于具名夹具排查加载问题，不加入原宿主界面。

服务与 renderer 分别使用 `pnpm exec tsc -p artifacts/installed-short-drama-preview/tsconfig.json` 和 `pnpm exec tsc -p artifacts/installed-short-drama-preview/tsconfig.ui.json` 检查，沿用原 Node/UI 类型环境，均不会构建 SDK。

进程收到 SIGINT/SIGTERM 后先撤销夹具授权、关闭自己的 Vite/Control 请求，再关闭原 UI mount、SQLite 连接，并仅删除自己创建的临时目录。启动失败也走相同清理。控制句柄写到 `output/extensions/checks/installed-short-drama-preview-ready.json`；停止失败会报告错误，不宣称资源已移除。不要删除官方 producer 的预构建源目录，也不要停止原 5719 进程。
