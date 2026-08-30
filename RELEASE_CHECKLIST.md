# 外部发布与运维门禁 Checklist

> 本清单记录从当前状态到完整生产发布的所有剩余工作项。代码层面的 W01 功能链已在 `codex/agent-runtime-migration-20260811` 分支闭环，以下均为"代码之外但能切状态到完成"的发布/运维门禁。

---

## 1. Desktop 发布签名链

### 1.1 Apple 生态（macOS）

| #     | 工作项                        | 状态      | 阻塞条件         | 备注                                                                         |
| ----- | ----------------------------- | --------- | ---------------- | ---------------------------------------------------------------------------- |
| 1.1.1 | Apple Developer Program 账号  | ❌ 未开始 | 需付费 $99/年    | 用于获取 Developer ID Application 证书                                       |
| 1.1.2 | Developer ID Application 证书 | ❌ 未开始 | 依赖 1.1.1       | 安装在 CI runner 或本地 keychain                                             |
| 1.1.3 | Apple 公证 (Notarization)     | ❌ 未开始 | 依赖 1.1.2       | 需配置 `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID`                       |
| 1.1.4 | Staple                        | ❌ 未开始 | 依赖 1.1.3       | Electron Builder 公证完成后附加票据                                          |
| 1.1.5 | Electron Updater 元数据       | ✅ 已配置 | —                | 构建产出 `latest-mac.yml`、zip 与 blockmap                                   |
| 1.1.6 | CI 发布 workflow              | ✅ 已配置 | 依赖 1.1.1~1.1.4 | `.github/workflows/release-desktop.yml` 已创建，推 `desktop-v*` tag 即可触发 |

**下一步行动**：

1. 注册/续费 Apple Developer Program
2. 在 GitHub repo Settings → Secrets 中配置：
   - `APPLE_CERTIFICATE`（base64 编码的 .p12）
   - `APPLE_CERTIFICATE_PASSWORD`
   - `APPLE_SIGNING_IDENTITY`（如 `Developer ID Application: Your Name (TEAM_ID)`）
   - `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID`（用于 notarytool）
   - `CSC_LINK` / `CSC_KEY_PASSWORD`（由 workflow 映射 Apple 证书 secrets）
3. 推送 `desktop-v0.x.0` tag 验证完整链路

### 1.2 Windows 生态

| #     | 工作项               | 状态      | 阻塞条件                           | 备注                                        |
| ----- | -------------------- | --------- | ---------------------------------- | ------------------------------------------- |
| 1.2.1 | Windows 代码签名证书 | ❌ 未开始 | 需购买或申请 Azure Trusted Signing | EV 证书可消除 SmartScreen 警告              |
| 1.2.2 | AuthentiCode 签名    | ❌ 未开始 | 依赖 1.2.1                         | 通过 Electron Builder 或独立签名步骤接入    |
| 1.2.3 | Timestamp 服务器     | ❌ 未开始 | 依赖 1.2.1                         | 跟随 Windows 代码签名方案配置               |
| 1.2.4 | NSIS 安装包构建      | ✅ 已配置 | —                                  | `apps/crewon-ui/package.json` 已配置 `nsis` |

**下一步行动**：

1. 选择签名方案：Azure Trusted Signing（推荐，按签名次数计费）或传统 EV 证书
2. 在 GitHub repo Settings → Secrets 中配置对应凭证
3. 取消 `.github/workflows/release-desktop.yml` 中 Windows 签名环境变量的注释

### 1.3 发布托管

| #     | 工作项                         | 状态        | 阻塞条件            | 备注                                                             |
| ----- | ------------------------------ | ----------- | ------------------- | ---------------------------------------------------------------- |
| 1.3.1 | GitHub Releases 发布           | ✅ 脚本就绪 | 依赖 1.1、1.2       | `scripts/release-local.mjs` 支持本地发布；CI workflow 支持自动化 |
| 1.3.2 | Updater manifest (latest.json) | ✅ 已配置   | —                   | endpoint 已指向 GitHub Releases                                  |
| 1.3.3 | 多平台 artifacts               | ⚠️ 部分就绪 | 需 Windows 构建通过 | 目前仅 `aarch64-apple-darwin` 在本地验证过                       |

---

## 2. 多租户 / Identity + 生产拓扑

| #   | 工作项                                     | 状态      | 阻塞条件       | 备注                                                   |
| --- | ------------------------------------------ | --------- | -------------- | ------------------------------------------------------ |
| 2.1 | PIM/Team 生产拓扑设计                      | ❌ 未开始 | 需架构决策     | 租户隔离模型、IAM 集成方式                             |
| 2.2 | Identity Provider 集成（OAuth2/OIDC/SAML） | ❌ 未开始 | 依赖 2.1       | `authorization-port.ts` 已定义授权接口，需对接具体 IdP |
| 2.3 | 跨主机网络策略                             | ❌ 未开始 | 依赖 2.1       | 服务间通信加密、mTLS                                   |
| 2.4 | 灾备演练（DR Drill）                       | ❌ 未开始 | 需生产环境到位 | PostgreSQL 流复制、跨区域故障切换                      |

**代码侧已就绪的基础设施**：

- `packages/application/src/authorization-port.ts` — 授权抽象接口
- `packages/domain/src/office.ts` / `office-delegation.ts` — 多租户空间模型
- `packages/store/src/postgres-*-store.ts` — PostgreSQL 持久化实现
- `docs/deployment.md` — 生产部署拓扑、Docker Compose/K8s 配置模板、灾备策略

---

## 3. 备份恢复与 SLO 演练

| #   | 工作项              | 状态        | 阻塞条件         | 备注                                                                     |
| --- | ------------------- | ----------- | ---------------- | ------------------------------------------------------------------------ |
| 3.1 | PostgreSQL 备份策略 | ✅ 脚本就绪 | 需部署环境验证   | `scripts/ops/backup-postgres.sh` 支持全量/物理/WAL 切换                  |
| 3.2 | 备份恢复演练        | ✅ 脚本就绪 | 需部署环境验证   | `scripts/ops/restore-postgres.sh` 支持逻辑恢复                           |
| 3.3 | SLO 定义与监控      | ✅ 文档就绪 | 需可观测性栈部署 | `docs/slo.md` 已定义黄金信号、错误预算、PromQL 规则                      |
| 3.4 | 混沌工程演练        | ✅ 脚本就绪 | 需部署环境验证   | `scripts/ops/chaos-drill.sh` 支持网络延迟/DB故障/磁盘满/内存压力/CPU饱和 |

---

## 快速启动指南（按优先级排序）

1. **立即可以做**：

   - 配置 GitHub Secrets（Apple 证书、公证账号等）
   - 推送 `desktop-v0.1.0` tag 测试 CI workflow（无 Apple 签名时 runner 会用 ad-hoc 签名，build 会通过但用户会收到"应用已损坏"提示）
   - 验证备份脚本语法：`bash -n scripts/ops/backup-postgres.sh && bash -n scripts/ops/restore-postgres.sh`

2. **需要外部采购/注册**：

   - Apple Developer Program（$99/年）
   - Windows 代码签名证书 或 Azure Trusted Signing 订阅

3. **需要生产环境到位后**：
   - PIM/Team 拓扑部署
   - 灾备演练
   - SLO 验证
