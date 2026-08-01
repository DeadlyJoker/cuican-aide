# W2-04RC Implementation Plan

## Stage E1: Private live catalog

1. [x] Red：新增 sibling Harness，先引用不存在的 catalog factory/session 与 resource processor。
2. [x] 抽取 provider connection begin/finish authority 校验，保持 connect/read 行为和错误闭集不变。
3. [x] 新增私有 `ProviderResourceCatalogFactory` / `ProviderResourceCatalog` RPITIT port，并在 production factory 上复用现有 Agent Platform client。
4. [x] 实现 resource list/read processor 与 secret-free projection；一次操作只建立一个 catalog session。
5. [x] 把 list/read 接入 `PreparedProviderConnectionRuntime` 的私有方法；不注册 RPC。
6. [x] targeted Resource/Provider Harness、完整 app-server package、scoped fix 与 final fmt。

## Stage E2: Experimental wire

1. [x] 注册 `resource/list`、`resource/read` experimental v2 方法，serialization 为 None。
2. [x] 新增独立 request processor 错误映射，不把业务逻辑写入 `MessageProcessor`。
3. [x] 生成 experimental schema 后恢复 stable vendored fixture。
4. [x] TestAppServer 覆盖 experimental gate、disabled runtime、unknown authority 字段和错误闭集。
5. [x] 更新 API README、上游 W2-04 verification 与 Gate；Resource Binding 仍后置。

## Review Gate

- E1 与 E2 分开评审。E1 新增的 catalog port、resource processor 和安全 Harness 合计 768 行，单个生产模块低于 500 行；共享 authority 抽取与 production/runtime 接线作为同一 E1 依赖链审查。E2 必须保持独立，不与 bind/UI 合并。
- 不新增 crate/dependency/config/migration；若必须新增，停止并重新做依赖与 Bazel lock 评审。
- 不改 v1、不接 UI、不实现 bind/unbind、不删除旧 Agent Platform 路径。
- 不运行完整 workspace `just test`，除非用户按仓库规则明确授权；包级测试可直接执行。
