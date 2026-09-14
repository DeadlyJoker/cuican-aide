/// <reference path="../../../packages/artifacts/src/xlsx-calc.d.ts" />
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import ExcelJS from "exceljs";
import calculate, { type CalcCell, type CalcWorkbook } from "xlsx-calc";
import { evaluateFormulas } from "../../../packages/artifacts/src/spreadsheet-formula.ts";
import type {
  Workbook,
  Cell,
} from "../../../packages/artifacts/src/spreadsheet-data.ts";

// Run from the repository root with Node 24 after the root-owned pnpm install.
const require = createRequire(import.meta.url);
assert.equal(require("xlsx-calc/package.json").version, "0.9.2");
assert.equal(require("exceljs/package.json").version, "4.4.0");
const source = new ExcelJS.Workbook();
await source.xlsx.readFile(
  new URL(
    "../../../apps/runtime-worker/src/fixtures/delivery-template.xlsx",
    import.meta.url,
  ).pathname,
);
const workbook: CalcWorkbook = { Sheets: {} };
const bounded: Workbook = { sheets: [], formulaCount: 0, parts: null };
source.eachSheet((sheet) => {
  const projected: Record<string, CalcCell> = {};
  const cells = new Map<string, Cell>();
  sheet.eachRow((row) =>
    row.eachCell({ includeEmpty: true }, (cell) => {
      if (cell.isMerged && cell.master.address !== cell.address) return;
      const value = cell.value;
      const formula =
        value !== null && typeof value === "object" && "formula" in value
          ? value.formula
          : undefined;
      const primitive =
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
          ? value
          : null;
      projected[cell.address] = formula ? { f: formula } : { v: primitive };
      cells.set(cell.address, {
        address: cell.address,
        row: Number(cell.row),
        column: Number(cell.col),
        value: primitive,
        ...(formula ? { formula } : {}),
      });
    }),
  );
  workbook.Sheets[sheet.name] = projected;
  bounded.sheets.push({
    name: sheet.name,
    path: "",
    rows: sheet.rowCount,
    columns: sheet.columnCount,
    cells,
    merges: [],
    dirty: false,
  });
});
const amounts = [10, 20, 30, 40, 50, 60, 7];
amounts.forEach((value, index) => {
  const key = `B${index + 2}`;
  workbook.Sheets.Report[key] = { v: value };
  bounded.sheets[0].cells.set(key, {
    address: key,
    row: index + 2,
    column: 2,
    value,
  });
});
calculate(workbook, { continue_after_error: false, log_error: false });
assert.equal(workbook.Sheets.Report.B10.v, 217);
assert.equal(workbook.Sheets.Report.C10.v, 434);
evaluateFormulas(bounded);
assert.equal(bounded.sheets[0].cells.get("B10")?.value, 217);
assert.equal(bounded.sheets[0].cells.get("C10")?.value, 434);
const rawBehavior = ["1/0", "SUM(", "1e-3", "SUM(A1)"].map((formula) => {
  const input: CalcWorkbook = {
    Sheets: { Probe: { A1: { v: true }, B1: { f: formula } } },
  };
  try {
    calculate(input, { continue_after_error: false, log_error: false });
    return { formula, cell: input.Sheets.Probe.B1 };
  } catch (error) {
    return { formula, error: String(error) };
  }
});
console.log(
  JSON.stringify(
    {
      node: process.version,
      packages: { "exceljs": "4.4.0", "xlsx-calc": "0.9.2" },
      fixture: "apps/runtime-worker/src/fixtures/delivery-template.xlsx",
      sheets: source.worksheets.length,
      rawAndBoundedAdapterResults: { B10: 217, C10: 434 },
      rawBehavior,
      result:
        "passed; production adapter rejects raw error/unfinished/coercion cases",
    },
    null,
    2,
  ),
);
