# 独立 UI 插件加载验证

这是确定性的本地验收夹具，不是生产安装页面，也不连接账号、模型、ComfyUI 或其他生成服务。宿主直接使用原 `DesktopWindowFrame` 和 `AppCommandShellRoute`，只增加测试模块入口；原首页、左右栏、字体、颜色与主题机制不变。

使用仓库固定的 Node.js 24、pnpm 10，并安装 workspace 依赖后，在终端运行：

```sh
node artifacts/installable-plugin-ui-preview/server.mts
```

打开 <http://127.0.0.1:5720/>，点击“独立插件验证”。服务器实际打包 SDK，在仓外临时目录离线安装并严格编译插件，再生成含 Node 入口、UI 入口和相对 ESM chunk 的两个预构建版本。它通过真实安装用例、SQLite 安装账本和本地 NodeHost 安装并启用 v1，然后删除整个开发目录及 node_modules；浏览器只从已安装的版本目录加载公开 UI 产物。

可验证调用测试计数能力、更新投影、退出后重新进入、升级 v2、卸载界面后重挂、撤销授权及停用。每次挂载获取独立引用；退出立即撤销本次界面动作资格，异步清理只处理自己的实例。版本升级实际提交选定版本修订，不修改宿主业务源码或重新构建宿主。

`/fixture-ui/*` 路由只服务本机测试：身份固定在服务端，通过随机 HttpOnly/SameSite cookie 关联，拒绝客户端 actor 头及跨来源 POST。它不是生产身份或授权实现。公开资源范围必须由宿主批准，混合包的 Node 入口不会随 UI 清单自动公开；资源读取复查当前身份、版本、权限及实际文件字节。动作仅允许 `counter.increment`，通过当前安装版本的实际 Node 服务执行。

当前加载器只支持可信 `trustedModule` 的 `module/main.content`。可信 UI 拥有普通 Renderer 权限，模块根节点和窄动作桥是协作边界，不是 DOM/网络安全沙箱。`isolatedWeb`、设置及结果贡献尚未实现，明确拒绝，不降级加载。原生 `import()` 没有逐入口 SRI，也无法取消已经开始的模块导入；不可变服务目录及逐次资源校验不等于不可信代码隔离。

终端输入 `stop` 或按 Ctrl+C 关闭本次服务器。清理会排空实际 Node 实例、关闭 SQLite，并删除本次临时目录；结果写入 `output/extensions/independent-ui/browser-server-evidence.json`。不要关闭或重启用户已有的 5719 短剧页面预览。

本次浏览器证据还包括 `native-assets-and-authorization.json`、`browser-behavior-evidence.json` 及 `native-installed-v2.jpg`。它覆盖仓外构建后删除源码、原生入口与相对 chunk、v1/v2 实际调用、投影更新、退出/重挂清理、资源拒绝和授权撤销。复杂短剧编辑器、正式安装 HTTP/UI、生产目录与权限组合、原 Run/Tool/积分接线、任务历史恢复及真实企业 API 验收仍在实施范围中。
