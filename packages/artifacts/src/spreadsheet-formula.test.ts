import assert from "node:assert/strict";
import test from "node:test";
import { DeliveryError, type SpreadsheetCellValue } from "@crewon/domain";
import { address, type Workbook } from "./spreadsheet-data.ts";
import { evaluateFormulas } from "./spreadsheet-formula.ts";

test("mature evaluator recalculates precedence, unary, absolute/range references and forward dependencies", () => {
  const book = workbook({
    A1: 10,
    A2: 20,
    A3: 30,
    B1: { formula: "SUM($A$1:$A$3)", value: 999 },
    C1: { formula: "B1*2" },
    D1: { formula: "(A1+A2)*2" },
    E1: { formula: "-A1+3" },
    F1: { formula: "SUM((A1+2),A2,3)" },
    G1: { formula: "A2/A1" },
    H1: { formula: "Z99" },
  });
  evaluateFormulas(book);
  assert.deepEqual(
    ["B1", "C1", "D1", "E1", "F1", "G1", "H1"].map(
      (key) => book.sheets[0].cells.get(key)?.value,
    ),
    [60, 120, 60, -7, 35, 2, 0],
  );
  assert.equal(book.formulaCount, 7);
  assert.equal(book.sheets[0].cells.get("B1")?.formula, "SUM($A$1:$A$3)");
});

test("error-valued and unfinished formulas cannot reuse stale caches or partially change the workbook", () => {
  for (const [formula, error] of [
    ["1/0", "formula_division_by_zero"],
    ["SUM(", "formula_unsupported"],
    ["1e-3", "formula_unsupported"],
    ["SUM(A1:A2", "formula_unsupported"],
    ["1 2", "formula_unsupported"],
    ["SUM()", "formula_unsupported"],
    ["A1:A2", "formula_unsupported"],
    ["SUM(A2:A1)", "formula_unsupported"],
    ["SUM(A1::A2)", "formula_unsupported"],
    ["MAX(A1:A2)", "formula_unsupported"],
    ["Other!A1", "formula_unsupported"],
  ]) {
    const book = workbook({
      A1: 10,
      A2: 20,
      B1: { formula, value: 999 },
      C1: { formula: "A1+A2", value: 888 },
    });
    assert.throws(
      () => evaluateFormulas(book),
      (actual) =>
        actual instanceof DeliveryError &&
        actual.code === `spreadsheet_${error}`,
      formula,
    );
    assert.equal(book.sheets[0].cells.get("B1")?.value, 999);
    assert.equal(book.sheets[0].cells.get("C1")?.value, 888);
  }
});

test("library coercions are outside the supported numeric formula contract", () => {
  for (const value of ["12", "header", true, false]) {
    for (const formula of ["SUM(A1)", "SUM(A1:A2)", "A1+3"]) {
      assert.throws(
        () => evaluateFormulas(workbook({ A1: value, A2: 2, B1: { formula } })),
        /spreadsheet_formula_non_numeric/,
      );
    }
  }
  assert.throws(
    () =>
      evaluateFormulas(
        workbook({ A1: Number.MAX_VALUE, B1: { formula: "A1*A1" } }),
      ),
    /spreadsheet_formula_non_finite/,
  );
});

test("direct, range and multi-node cycles fail through the bounded adapter without native stack overflow", () => {
  const cases: Parameters<typeof workbook>[0][] = [
    { A1: { formula: "A1" } },
    { A1: { formula: "SUM(A1:A2)" }, A2: 2 },
    { A1: { formula: "B1" }, B1: { formula: "C1" }, C1: { formula: "A1" } },
  ];
  for (const cells of cases)
    assert.throws(
      () => evaluateFormulas(workbook(cells)),
      (error) =>
        error instanceof DeliveryError &&
        error.code === "spreadsheet_formula_cycle",
    );
});

test("static admission bounds formula counts, nesting and range expansion while preserving a 128-cell dependency chain", () => {
  const chain: Record<string, { formula: string }> = {};
  for (let i = 128; i >= 1; i--)
    chain[`A${i}`] = { formula: i === 128 ? "1" : `A${i + 1}+1` };
  const book = workbook(chain);
  evaluateFormulas(book);
  assert.equal(book.sheets[0].cells.get("A1")?.value, 128);
  assert.throws(
    () => evaluateFormulas(workbook({ ...chain, A129: { formula: "1" } })),
    /spreadsheet_formula_budget_exceeded/,
  );
  assert.throws(
    () =>
      evaluateFormulas(
        workbook({ A1: { formula: `${"(".repeat(65)}1${")".repeat(65)}` } }),
      ),
    /spreadsheet_formula_depth_exceeded/,
  );
  assert.throws(
    () => evaluateFormulas(workbook({ A1: { formula: "SUM(B1:IU100000)" } })),
    /spreadsheet_formula_budget_exceeded/,
  );
});

function workbook(
  values: Record<
    string,
    SpreadsheetCellValue | { formula: string; value?: SpreadsheetCellValue }
  >,
): Workbook {
  const cells = new Map(
    Object.entries(values).map(([key, value]) => {
      const ref = address(key);
      return [
        key,
        {
          address: key,
          row: ref.row,
          column: ref.column,
          ...(value !== null && typeof value === "object"
            ? { formula: value.formula, value: value.value ?? null }
            : { value }),
        },
      ];
    }),
  );
  return {
    sheets: [
      {
        name: "Sheet1",
        path: "",
        rows: 100000,
        columns: 256,
        cells,
        merges: [],
        dirty: false,
      },
    ],
    parts: null,
    formulaCount: 0,
  };
}
