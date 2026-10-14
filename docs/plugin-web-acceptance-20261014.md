# 插件 Web 验收与执行部署边界（2026-10-14）

当前验收入口为 `https://crewon.aicuican.com/plugin-next/index.html?cwd=`。正式 `/` 和桌面包尚未从本次候选验收升级。

## 已观察到的真实 Web 行为

- 短剧包 `54.0.0` 已安装并启用，摘要为 `sha256:f73a7a6c843509abbeec665948e067abfe527cb3574815b0db8c89d02610eec7`。
- 进入项目会自动创建或恢复隔离会话，使用原工作空间注册、分配、SQL 绑定能力。真实项目 `01a13872-9a56-714c-b578-19e8262a2915` 恢复到同一 Thread `01a138ba-a6b5-73ea-92e0-b65cb5b71070`。
- 右侧点击“角色”后，中间共享聊天显示“当前阶段：角色”；点击导航未执行模型任务。
- 新消息在请求完成前已显示；本次发送后的 UI 观察耗时 439ms，包括工具操作和读取页面的开销。
- 原聊天上下文 GET 曾被 BFF 的普通项目响应上限拒绝，返回 502。已独立使用该路由声明的有限 JSON 预算，真实已登录请求现在返回 200；403 仍透传，超限仍拒绝。

## 加载修复

公共 preload helper 曾让入口静态依赖整个 Mermaid 模块。现在单独拆出 runtime chunk，构建验收沿真实静态 import 和 modulepreload 依赖检查：初始 JS 合计 326436 字节，图表和表格保持按需加载。

Cloudflare 曾改写入口 module 标签。构建后处理保留 `data-cfasync="false"`，并增加构建产物检查；真实线上 DOM 已验证该标记生效。

候选页原带哈希静态资源返回 `Cache-Control: no-store`，现在返回 `public, max-age=31536000, immutable` 并启用 gzip。缓存规则只匹配公共 Vite JS/CSS，不匹配鉴权的插件 mount 资源及 API。尚未取得足够的真实冷启动计时，不能承诺具体启动秒数。

## 当前执行阻塞

真实方案请求在模型调用前返回 `installed_plugin_request_authority_unavailable`，尚未生成或保存线上方案。

只读检查线上 `core_candidate`：普通 Agent 有发布记录，但插件 configuration、activation、Run binding 均为 0。Control 未配置 installed task owner，Worker 未配置 installed execution release/private peer。现有 24 个模型 binding 都是 `shared`，而原 installed release 要求独立 source binding。

现有私有桥提供登录验证、profile、安装/UI policy 和 Control policy，尚缺 Worker actor、execution package、quote 协议。Remote Worker 也尚未显式组合项目 Foundation、outline、script、assets 服务。包内这些服务为 optional，readiness 成功仍不足以证明工具实际可用。

源码内已补当前 Run/Tool/lease、完整归属与 namespace 校验的读取和写入路径，并使用真实 PostgreSQL/SQLite 回归；这些源码测试不等于线上执行验收。资产 UI 本轮覆盖正向只读，采用、锁定及媒体 adoption 的 UI 正向写入仍需单独落地。

## 后续实施顺序

1. 在原 Authority/Worker 组合中接实际 actor/package 授权与明确项目服务声明，复用 PIM 登录、profile、PDP 和原 PostgreSQL managers。
2. 从原 configuration PUT 保存真实包配置。积分后置时，为 production composition 接原 Core 的明确 unmetered authority，不伪造价格、余额或资金。
3. 复用原 provider、模型和凭据，发布独立 source Agent 与 binding，再用原 compiler 和 release CLI 发布插件 Agent/target；保留原 default 和已有模型。
4. 原 Worker/private peer 验证完整发布，再启用 Control installed task 配置和原 activation PUT。
5. 在 Web 验收 Foundation → outline → script → assets：要求真实工具结果、原 SQL 产物、刷新读回和权限撤销行为。通过后再更新正式入口和桌面。

所有服务切换前保存私有配置、容器、原二进制和数据备份；常规回滚恢复服务和选择，不覆盖数据库或会话历史。
