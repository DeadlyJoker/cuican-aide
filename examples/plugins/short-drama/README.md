# 独立短剧工作台页面插件

将整个目录复制到 CrewON 仓库外开发。公开依赖仅为 `@crewon/plugin-sdk/ui`、React、ReactDOM 和 lucide-react；浏览器产物包含插件自己的 React 和全部依赖，不借用宿主源码、组件、React 实例或工作区样式表。

保留原 `lucide-react 0.468.0` 图标。React 19 类型移除了其声明引用的 `ReactSVG`，包内仅以无运行时代码的声明补回 SVG 标签名映射；`strict` 与 `skipLibCheck: false` 保持启用，不更换图标或降低类型检查。

包标识为 `crewon.short-drama`，模块标识为 `workbench`，默认版本为 2.0.0。它声明一个 `trustedModule/main.content` 页面及必须可用的 `crewon.creative-projects@1` 服务；没有 Node 入口、业务能力清单、任务动作或执行工厂。安装和启用须通过原可信发布者/包策略及宿主明确的项目服务批准；共享 DOM 模式不是安全沙箱。

## 仓外构建

使用 Node.js 24、pnpm 10.33.0。SDK 尚未发布到 registry，先由宿主的统一 SDK 分发步骤提供 `crewon-plugin-sdk-0.1.0.tgz`，再在复制后的独立项目中执行：

```sh
pnpm add /absolute/sdk-output/crewon-plugin-sdk-0.1.0.tgz
pnpm install --ignore-scripts
pnpm build
pnpm test
```

`dist/2.0.0/` 是完整预构建安装目录。`crewon.plugin.json` 清单包含 UI ESM、演示使用的已有 Krea2 示意 PNG 与依赖许可文件的实际字节数和 SHA256。构建拒绝仓外源码依赖与未打包的浏览器依赖；安装器无需执行脚本。可以设置 `CREWON_EXAMPLE_PLUGIN_VERSION=3.0.0 pnpm build` 构建升级版本，测试时设置相同变量。既有 1.0.0 预览包保持独立。

## 页面与生命周期

默认模式在实际 Host ready 后，通过公开 SDK 读取当前用户的项目，提供创建、归档/恢复、需求保存和版本历史。未就绪不发送动作；服务不可用时明确提示，不用示例项目冒充保存结果。写入使用真实项目 revision 和独立幂等键，保留文本原文；版本冲突保留草稿并要求确认，响应未知只重试同一输入/原键。概念输入、生图、选用和后续创作阶段尚未接入，不创建生成任务或扣费。

只有可信预览显式传入 `props.data.shortDramaPreview=true` 才进入原演示模式：示例项目、概念图、模拟提交/查询和服务弹窗继续只改变内存演示状态。PNG 是已有测试样例；演示不调用生图或视频服务，不冻结或扣除积分。

每次挂载创建独立 React 根和局部样式节点，主题更新仅修改该模块拥有的元素与 CSS 变量，保持现有表单和项目状态。样式选择器与原页面一样限定在 `.drama-workbench`；字体、色彩、间距、圆角与阴影沿用宿主原主题。当前 CrewON 宿主通过公开 `theme.tokens` 投影提供原页面使用的全部 32 个变量，包含原 control、spacing、radius、shadow 和 code-font 变量；插件将它们写在本模块自己的节点上。较旧的宿主缺少部分投影时仍继承可信共享 DOM 的原变量。此包仅声明共享 DOM 模式，不承诺独立 WebView 的主题或隔离兼容。

离开页面或停用时撤回迟到响应、卸载 React、关闭仍打开的原生 dialog，并删除本次挂载拥有的节点。重复卸载不会删除后续挂载或宿主其他内容。默认模式重新挂载会从项目服务读取已保存数据，未保存草稿不写入浏览器存储。显式演示模式重开会重置示例数据。插件不读取账号凭据或用户积分，不从页面传入 owner、付款方或执行身份。

`pnpm test` 对实际构建 ESM 运行持久模式和显式演示模式的行为与生命周期检查。包内使用公开 happy-dom 与严格 metadata fixture，不能据此宣称生产保存或浏览器原生 dialog 已验证。宿主另有真实安装字节、HTTP、SQLite/PostgreSQL 与冷恢复集成；正式 Main/full App/packaged 生图与积分验收仍待完成。原工作区、左右栏和账号设置入口属于宿主，插件只修改自己的模块节点。
