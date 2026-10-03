# 短剧 9.0.0 与 Krea2 的生产项目配置

日期：2026-10-04。当前交付是从实际独立包生成的项目部署配置及来源证明，尚未应用到用户服务。它减少部署时手工填写包摘要、模块贡献和结果验证身份的错配；完整在线 S0 验收仍待完成。

## 本机产物

- 配置：`output/extensions/deployment-prep/short-drama9-krea2-20261004/production-project-composition.json`。
- 来源与校验：同目录 `verification.json`。
- 本次生成过程：`output/extensions/checks/prepare-short-drama9-project-config-20261004.mjs` 及同名 `.log`。这是本次产物的复核脚本，没有新增产品 CLI 或构建系统。

配置使用现有 `crewon.production-project-composition.v1`，完整 SHA-256 为 `d4ee9463833a982a521e98639c94c4608a07c28d52dab0dd00ee726f15ccc83b`。实际文件权限为 `0600`、单硬链接，已通过正式 `loadProductionProjectEnvironment(..., "production")` 重读；相同配置在 Standalone 模式被拒绝。

| 实际包                 | 版本与贡献            | 核验后的 packageDigest                                                    |
| ---------------------- | --------------------- | ------------------------------------------------------------------------- |
| `crewon.short-drama`   | `9.0.0` / `workbench` | `sha256:981c3bcdb7fc9c47186118a482bb1d8ec3dd1d4f95d3a09139f7a104dfba2334` |
| `crewon.comfyui-krea2` | `2.0.0` / `studio`    | `sha256:17d661fd3f1259feca502208907966ab6df70a625c97d6def51eddc6aa366ebb` |

原公开 Host verifier 核验完整交付目录。在独立、临时、宿主拥有的安装根复制两份包后，公共 `loadInstalledPluginBusinessRegistration` 和 `revalidateInstalledPluginBusinessRegistration` 从实际安装字节读取 Krea2 业务身份。临时根已删除；没有写入用户 profile、安装选择或数据库，也没有导入包的 Node/UI 业务模块。

结果验证使用 Krea2 `2.0.0` 的实际业务身份：

- `manifestDigest`：`sha256:dad6282da04759ab86bfceb8396b2a29795ba2abeb964a703a9f1d996cc6f5a1`。
- `implementationDigest`：`sha256:219c277fdd5ee3b4067c7f2f8b57b7e38e7c3306c651cf091678c4579c260c8f`。

## 配置的作用

八项配置分别接入项目 UI、项目生成、显式查询、只读生成记录、记录 UI、图片结果验证、选用 UI 和三类原请求恢复。所有来源固定为上述短剧包的 `workbench`；生成与查询目标固定为上述 Krea2 包的 `studio`，动作分别为现有适配器的 `image.generate` 和 `image.query`。

这两个动作是明确的部署选择。包 descriptor 只声明贡献点，不包含运行时 action 声明；正式 owner 仍须在调用时核验实际 Node service 的 action。文件校验和业务 registration 不能证明 Worker 已部署或供应商在线。生成上下文与就绪检查由现有生成 owner 提供，无需新增配置字段。

正式 Production Control 可通过 `CREWON_PROJECT_COMPOSITION_CONFIG_PATH` 读取该私有文件，安装根和完整包身份须与现有安装/UI/task 配置一致。复制文件到实际部署位置时，仍须满足原私有文件的规范绝对路径、当前 OS 用户、`0600` 与单硬链接要求。现有 Main 保持 opt-in；未将此变量注入当前用户的 Standalone 服务。

## 联合在线验收的剩余前提

沿[正式任务启动](./installed-plugin-task-startup.md)配置真实身份、profile、策略、包许可、网络许可、Worker peer、模型、PostgreSQL 和已发布 Agent bundle，并完成实际包安装选择、首次配置及 activation。项目配置只固定映射和验证身份，不替代这些实际部署事实。

个人插件积分还需实际账户和资金来源、单价及计费单位、结算时机和失败处理规则。现有原 Run 的预留事务继续使用真实服务端报价，不能把具名测试 grant 或冻结记录作为生产扣款。

本轮只读检查用户原 ComfyUI 地址的首页、`/queue` 和 `/system_stats`，均返回 HTTP 404；没有发送生成请求。证据为 `output/extensions/checks/comfyui-original-service-availability-20261004-deployment-review.json`。服务恢复或提供实际新地址后，仍须从原完整 App 验收同一次保存、生成、Worker/外部任务、显式查询、选用及重启恢复。

原 App、账号/设置、两侧栏及样式没有改动；14 个保护源文件、15 份正式 UI 资产、冻结 SDK tarball 和旧短剧 8.0.0 包均复核一致。Native/打包版的完整接线与执行、第二个实际企业 API 仍属完整目标的未完成项。
