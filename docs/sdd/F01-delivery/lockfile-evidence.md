# F01 公开 npm 锁条目修复

2026-09-14。仅修正 F01 实现提交 3745d6a79 引入的 resolution；比较基线为 9afef710f。没有升级包版本、改变依赖图或业务代码。

- 全部 50 个新增公开包使用官方 HTTPS tarball 和官方 dist.integrity SHA-512。元数据请求固定包名/版本，不解析 latest。
- 用无认证头的 Node fetch 逐个请求 registry.npmjs.org 元数据，并实际下载全部 50 个 tarball，共 6,113,163 bytes。每份下载同时核对官方 SHA-512、官方 shasum、原锁条目 SHA-1，全部相符。
- 发现 F01 安装过程还误改了原有 tmp@0.2.7 的 resolution；此次原样恢复基线 SHA-512。除此撤销误改外，不调整任何既有条目；已逐块断言全部基线 package block 与原文一致。
- 屏蔽 resolution 行后，整个 lockfile 与修复前完全相同。importers、snapshots、版本和其它字段均未改变。
- 没有读取、打印或保存 npm 认证配置。保留的证据仅包含公开元数据、URL、摘要及校验结果。

逐包证据：[lockfile-public-registry.json](evidence/lockfile-public-registry.json)。其中 metadataSha256 是本次实际元数据响应摘要，actualIntegrity 来自实际 tarball bytes，priorSha1Matches 证明没有替换包内容。

验证使用 Node 24.19.0 / pnpm 10.33.0：

1. pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org --reporter=append-only：通过，未修改 lockfile。安装使用当前 workspace/store；公开可下载性另由上述逐包实际 HTTP 下载证明。
2. pnpm --filter @crewon/artifacts test：37/37 通过。
3. pnpm --filter @crewon/artifacts typecheck：通过。
4. pnpm format 与 git diff --check：通过。

此次不重跑业务全套测试，也不改基线已有的其它私有 registry 条目；因此不宣称整个历史依赖树已完成外部 CI 可移植性修复。
