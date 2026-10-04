# 原打包应用的三类 prepared 恢复

本专项验证原 `.app` 与独立短剧 9.0.0 的持久请求恢复，接续[原设置页安装和项目输入冷读取](./native-packaged-projects-window.md)。原批准发行包、正式 Renderer、Main、preload、鉴权 transport 与 SQLite 保持；真实打包入口使用独占私有 userData，不重启用户服务。

第一次 Main 从原账号菜单打开十类设置，在工具与扩展安装并启用原短剧来源，固定 selection revision 2。原插件表单保存项目、需求和概念输入，并通过原按钮创建任务 Thread。测试观察者从原鉴权请求取得会话信息，使用原 ControlApiClient 将 generation、query、selection 三条完整命令暂存到原 recovery API，逐项读取真实 prepared ACK。不直接插入 journal，不调用这三个业务动作。

查询与选用使用明确不存在的 operationId，因此不会产生成功历史、图片选用或派发。三项都保持原 request、原幂等键、输入 CAS、完整安装来源 pin、prepared phase、dispatchAttemptCount 0 和 receipt null。这些是可恢复的未派发请求，不是已经生成图片的证据，也不证明用户按三个业务按钮曾取得 ACK。

第一个 Main 与所有实际 runtime 子进程物理退场后，同一 userData 启动新的原 Main。原模块在 ready 前完成真实 recovery GET，页面显示三类未确认状态，读回相同项目输入和完整请求。冷 hydrate 不自动报价、创建任务、派发、查询或选用；原账务、Run、供应商 operation 和项目关联保持。安装修订始终不变，不把旧测试中重装后的 revision 6 当成旧请求的新许可。

打包构建仅在自有测试目录编译原 Host/runtime 并复制已有正式 Renderer；SDK、冻结 tarball 和发布插件包不重建。自然打包身份、asar/runtime 摘要、OS 子进程身份与退场、原账号/Settings 和模块截图各自保留证据。具名模型只提供原模型目录，原初始 100 测试积分保持；这不是生产身份、拨款、定价或扣费。

本专项最终 **1/1、零跳过、实际退出码 0**。前两次失败分别为测试从实包根内寻找宿主会话按钮、测试未解析 DB JSON 就调用对象校验器；只修测试，原日志和截图保留。原创建 Thread、三次 ACK 与冷恢复在最终用例一起验证；清理异常与主流程异常合并保留，只有物理消费者退场后才删除私有 fixture，外部证据目录保持。

本专项不覆盖成功生成/查询/选用、完整在线 S0、短剧 10.0.0 或全部插件打包链路。`createThread` 本身也不属于三类 recovery 协议。实际结果以[实施进度](./incremental-extension-progress.md)和 `output/extensions/checks/native-packaged-recovery-app-verified-20261004/native-packaged-recovery-app-proof.json` 为准。
