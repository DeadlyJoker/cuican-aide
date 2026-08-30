# W1-04 Tasks

## A. Domain contract

- [x] A1 新建最小 `crewon-resource-federation` crate 和 workspace/Bazel build wiring。
- [x] A2 定义 bounded Provider/Resource/Revision/Schema/Digest/Cursor 类型。
- [x] A3 定义六类核心资源、四种 BindingMode 和两种 ExecutionLocation 闭集。
- [x] A4 定义 Manifest、Capability snapshot、Binding request/materialization/resolved result。
- [x] A5 为集合、分页和字符串建立硬上限与 serde 校验。

## B. Harness-first resolver

- [x] B1 表驱动覆盖四种合法绑定并比较完整结果对象。
- [x] B2 覆盖 Provider/resource/revision mismatch。
- [x] B3 覆盖 mode/location/capability 冲突。
- [x] B4 覆盖 immutable snapshot 和 local fork provenance 校验。
- [x] B5 覆盖远程绑定夹带物化拒绝。
- [x] B6 覆盖未知 capability/field fail-closed。

## C. Provider port

- [x] C1 定义 documented RPITIT `CatalogProvider`。
- [x] C2 定义 bounded list query/page 与有限 Provider error。
- [x] C3 确认没有动态 Registry、HTTP、DB、Credential 或下载 API。

## D. Verification

- [x] D1 `just test -p crewon-resource-federation`。
- [x] D2 扫描 Cargo/source 依赖边界。
- [x] D3 `just bazel-lock-update` 与 `just bazel-lock-check`。
- [x] D4 `just fix -p crewon-resource-federation`，最后 `just fmt`。
- [x] D5 记录 staged diff、未接消费者和全量测试边界。
