# F01 成熟公式库复用决策

核对日期：2026-09-14。采用准确版本 **xlsx-calc 0.9.2**。它负责公式解析、依赖解析与实际计算，替换 `spreadsheet-formula.ts` 原有的递归表达式与 SUM 求值实现；产品侧仅保留支持策略、预算、类型转换和错误校验。

## 候选与来源

| 候选                       | 许可证与维护事实                                                          | API / TypeScript                                                                       | 决策                                       |
| -------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------ |
| xlsx-calc 0.9.2            | MIT；npm 发布时间 2024-08-16；GitHub 非归档，pushed_at 为 2026-03-25      | CommonJS `calculate({Sheets}, options)`；无 production 依赖，无随包 types/engines 声明 | 采用并锁版本；Node 24 实测                 |
| fast-formula-parser 1.0.19 | MIT；最后 npm 发布时间 2020-11-26；GitHub 非归档，pushed_at 为 2025-09-10 | parser.parse + onCell/onRange；4 个 production 依赖，无随包 types/engines 声明         | 本轮不增加旧解析器依赖                     |
| @formulajs/formulajs 4.6.1 | MIT；npm 发布时间 2026-07-28；GitHub 非归档                               | ESM/CJS 与 TS 声明；主要为单个 Excel 函数实现                                          | 本轮无需增加；单独使用仍缺少工作簿依赖解析 |

一手来源：[xlsx-calc 官方 README 和 MIT 条款](https://github.com/fabiooshiro/xlsx-calc/tree/main#mit-license)、[准确版本声明](https://github.com/fabiooshiro/xlsx-calc/blob/main/package.json)、[npm 元数据](https://registry.npmjs.org/xlsx-calc)、[维护信息](https://api.github.com/repos/fabiooshiro/xlsx-calc)。MIT 条款在 README 内，仓库未单设 LICENSE 文件。

[fast-formula-parser 官方 API](https://github.com/LesterLyu/fast-formula-parser)、[LICENSE](https://github.com/LesterLyu/fast-formula-parser/blob/master/LICENSE)、[npm 元数据](https://registry.npmjs.org/fast-formula-parser)、[维护信息](https://api.github.com/repos/LesterLyu/fast-formula-parser)。[Formula.js 官方 API](https://github.com/formulajs/formulajs)、[LICENSE](https://github.com/formulajs/formulajs/blob/master/LICENSE)、[包配置与声明入口](https://github.com/formulajs/formulajs/blob/master/package.json)、[npm 元数据](https://registry.npmjs.org/%40formulajs%2Fformulajs)。GitHub push 时间只描述提交活动，不视为上游支持保证。

## Node 24 探针与实际文件

运行 [reuse-probe-formula.ts](reuse-probe-formula.ts)：

```sh
node --experimental-strip-types docs/sdd/F01-delivery/reuse-probe-formula.ts
node --experimental-strip-types --test packages/artifacts/src/spreadsheet-formula.test.ts
```

探针使用 ExcelJS 4.4.0 读取真实四表 XLSX fixture，再调用 xlsx-calc 的公开 `{Sheets: {name: {A1: {v}, B1: {f}}}}` 接口。七笔输入的 B10/C10 结果为 217/434；成熟库和生产适配器结果相同。公式缓存没有作为输入结果复用。首次独立取包时核对 npm SHA-512 完整性：`tp6ASfuqFP1QIcNgsB6fjeFMNCWii8jbqhcg/7w6XVRQb5H24RB8HOHA3SbJD+rUqmIqhnd7v0h4XE+LvullnA==`；root 随后统一加入 pnpm 锁文件。没有引入第二个产品运行时。

独立反例实测暴露的上游行为及已实现处理：

- `1/0` 可返回 `{t: "e", w: "#DIV/0!", v: 7}` 而不 throw；适配器识别错误单元格，明确拒绝。
- 未闭合 `SUM(`、`1e-3` 可能不产生值；策略拒绝未完成语法及科学记数法字面量，并要求每个公式实际返回有限数值。
- `SUM(A1)` 把布尔或数字字符串当数字；首版引用范围只准数字/空值，其余明确 `formula_non_numeric`，保留用户原值。
- 三节点循环上游可能直到 native stack overflow 才失败；锁定 API 的每个公式属性通常读两次，适配器将重复读取封顶 8 次，提前报 `formula_cycle`。没有自行求值或建立替代依赖引擎。

## 首版支持策略

允许同表 A1/绝对引用、十进制数值、四则、括号、SUM 参数与矩形范围；空的标量引用按零处理。跨表/外部链接、名称、数组、其他函数、科学记数法公式字面量及非数字引用明确拒绝。

每本最多 128 个公式、每公式 2048 字符/512 tokens/64 层括号；全书引用预算 2,000,000 单元格。128 个前向依赖公式通过。超过公式数、嵌套或 range 预算明确失败。校验所有返回值后才更新原 workbook，避免一个失败公式留下局部新缓存。类型声明为 `xlsx-calc.d.ts` 的窄公开 API；无 fork 上游库或自写公式函数。

公式独立行为测试覆盖实际优先级、绝对引用、前向依赖、空值、缓存拒绝、原值保留、非数值类型、三种循环和预算。XLSX 保存/格式保真由 ExcelJS 集成测试与独立文件读者继续核对，不由公式库承担。
