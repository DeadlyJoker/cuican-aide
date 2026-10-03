# 独立短剧工作台页面插件

将整个目录复制到 CrewON 仓库外开发。公开依赖仅为 `@crewon/plugin-sdk/ui`、React、ReactDOM 和 lucide-react；浏览器产物包含插件自己的 React 和全部依赖，不借用宿主源码、组件、React 实例或工作区样式表。

保留原 `lucide-react 0.468.0` 图标。React 19 类型移除了其声明引用的 `ReactSVG`，包内仅以无运行时代码的声明补回 SVG 标签名映射；`strict` 与 `skipLibCheck: false` 保持启用，不更换图标或降低类型检查。

包标识为 `crewon.short-drama`，模块标识为 `workbench`。它只声明一个 `trustedModule/main.content` 页面：没有 Node 入口、业务能力清单、任务动作或执行工厂，也不请求宿主服务。安装时仍须通过宿主显式可信发布者与包权限策略；共享 DOM 模式不是安全沙箱。

## 仓外构建

使用 Node.js 24、pnpm 10.33.0。SDK 尚未发布到 registry，先由宿主的统一 SDK 分发步骤提供 `crewon-plugin-sdk-0.1.0.tgz`，再在复制后的独立项目中执行：

```sh
pnpm add /absolute/sdk-output/crewon-plugin-sdk-0.1.0.tgz
pnpm install --ignore-scripts
pnpm build
pnpm test
```

`dist/1.0.0/` 是完整预构建安装目录。`crewon.plugin.json` 清单包含 UI ESM、已有 Krea2 示意 PNG 与依赖许可文件的实际字节数和 SHA256。构建拒绝仓外源码依赖与未打包的浏览器依赖；安装器无需执行脚本。可以设置 `CREWON_EXAMPLE_PLUGIN_VERSION=2.0.0 pnpm build` 构建升级版本。使用非默认版本运行测试时设置相同变量。

## 页面与生命周期

保留原演示的项目搜索、新建、归档与恢复、需求版本历史、概念图版本、模拟提交与查询、画面选用、生成记录和服务设置弹窗。后四个短剧创作阶段继续标为“后续开放”。PNG 是已有测试样例，点击“开始生成”或“查询原任务”只改变内存演示状态，不请求生图或视频服务，不创建 Run，不冻结或扣除积分。

每次挂载创建独立 React 根和局部样式节点，主题更新仅修改该模块拥有的元素与 CSS 变量，保持现有表单和项目状态。样式选择器与原页面一样限定在 `.drama-workbench`；字体、色彩、间距、圆角与阴影沿用宿主原主题。当前 CrewON 宿主通过公开 `theme.tokens` 投影提供原页面使用的全部 32 个变量，包含原 control、spacing、radius、shadow 和 code-font 变量；插件将它们写在本模块自己的节点上。较旧的宿主缺少部分投影时仍继承可信共享 DOM 的原变量。此包仅声明共享 DOM 模式，不承诺独立 WebView 的主题或隔离兼容。

离开页面或停用时卸载 React、清理通知定时器、关闭仍打开的原生 dialog，并删除本次挂载拥有的节点。重复卸载不会删除后续挂载或宿主其他内容。再次打开从演示初始数据开始；页面明确显示“离开模块后重开会重置演示数据”。数据不会保存到后端或浏览器存储，也不读取登录账号、用户积分或真实创作项目。

`pnpm test` 对实际构建 ESM 运行页面行为与生命周期检查。它使用公开 happy-dom 测试环境，不证明浏览器原生对话框、正式安装授权或生产 HTTP 的端到端接线。最终宿主验收应从仓外构建目录安装、删除开发目录，使用已有 installed UI loader 读取经过批准的 ESM 与 PNG，检查主题切换、弹窗中离开、重开重置与停用后清理，并确认原工作区、左右栏和账号设置入口保持原样。
