/// <reference path="./xlsx-calc.d.ts" />
import calculate, { type CalcCell, type CalcWorkbook } from "xlsx-calc";
import { DeliveryError } from "@crewon/domain";
import {
  address,
  columnName,
  fail,
  type Cell,
  type Sheet,
  type Workbook,
} from "./spreadsheet-data.ts";

const MAX_FORMULAS = 128;
const MAX_REFERENCED_CELLS = 2_000_000;
const MAX_FORMULA_READS = 8;
type Token = { kind: "number" | "ref" | "symbol" | "sum"; value: string };

/** Admission policy only: the external calculator owns parsing, dependencies, and arithmetic. */
function admittedTokens(formula: string): Token[] {
  if (formula.length < 1 || formula.length > 2048) fail("formula_unsupported");
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < formula.length) {
    const rest = formula.slice(offset);
    const whitespace = /^\s+/u.exec(rest);
    if (whitespace) {
      offset += whitespace[0].length;
      continue;
    }
    // Scientific literals are excluded: xlsx-calc 0.9.2 does not reliably complete 1e-3.
    const match =
      /^(SUM(?=\s*\()|\$?[A-Z]{1,3}\$?[1-9]\d*|(?:\d+(?:\.\d*)?|\.\d+)|[+*/():,\-])/u.exec(
        rest,
      );
    if (!match) fail("formula_unsupported");
    const value = match[0];
    offset += value.length;
    tokens.push({
      kind:
        value === "SUM"
          ? "sum"
          : /^\$?[A-Z]/u.test(value)
            ? "ref"
            : /^[.\d]/u.test(value)
              ? "number"
              : "symbol",
      value,
    });
    if (tokens.length > 512) fail("formula_unsupported");
  }
  // Reject malformed delimiters/adjacent operands before the library can retain an old cache.
  // This scan neither builds an expression tree nor computes an expression.
  const frames: ("sum" | "group")[] = [];
  let operand = true;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "sum") {
      if (!operand || tokens[i + 1]?.value !== "(") fail("formula_unsupported");
    } else if (token.kind === "number" || token.kind === "ref") {
      if (!operand) fail("formula_unsupported");
      if (token.kind === "number" && !Number.isFinite(Number(token.value)))
        fail("formula_non_finite");
      operand = false;
    } else if (token.value === "(") {
      if (!operand) fail("formula_unsupported");
      frames.push(tokens[i - 1]?.kind === "sum" ? "sum" : "group");
      if (frames.length > 64) fail("formula_depth_exceeded");
    } else if (token.value === ")") {
      if (operand || frames.length === 0) fail("formula_unsupported");
      frames.pop();
      operand = false;
    } else if (token.value === ",") {
      if (operand || frames.at(-1) !== "sum") fail("formula_unsupported");
      operand = true;
    } else if (token.value === ":") {
      if (
        frames.at(-1) !== "sum" ||
        tokens[i - 1]?.kind !== "ref" ||
        tokens[i + 1]?.kind !== "ref" ||
        !["(", ","].includes(tokens[i - 2]?.value) ||
        ![",", ")"].includes(tokens[i + 2]?.value)
      )
        fail("formula_unsupported");
      i++;
    } else {
      if (operand && token.value !== "+" && token.value !== "-")
        fail("formula_unsupported");
      operand = true;
    }
  }
  if (operand || frames.length !== 0) fail("formula_unsupported");
  return tokens;
}

function numericReference(cell: Cell | undefined): void {
  // Avoid the library's numeric-text/boolean coercions, which differ from Excel SUM references.
  if (
    cell?.formula === undefined &&
    cell?.value !== null &&
    cell?.value !== undefined &&
    typeof cell.value !== "number"
  )
    fail("formula_non_numeric");
}

function referenceCost(sheet: Sheet, tokens: readonly Token[]): number {
  let cost = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== "ref") continue;
    const first = address(token.value);
    if (tokens[i + 1]?.value !== ":") {
      numericReference(sheet.cells.get(first.key));
      cost++;
      continue;
    }
    const last = address(tokens[i + 2].value);
    if (first.row > last.row || first.column > last.column)
      fail("formula_unsupported");
    cost += (last.row - first.row + 1) * (last.column - first.column + 1);
    if (cost > MAX_REFERENCED_CELLS) fail("formula_budget_exceeded");
    for (let row = first.row; row <= last.row; row++) {
      for (let column = first.column; column <= last.column; column++)
        numericReference(sheet.cells.get(`${columnName(column)}${row}`));
    }
    i += 2;
  }
  return cost;
}

/** Uses locked xlsx-calc to recalculate supported numeric formulas; never falls back to cached values. */
export function evaluateFormulas(book: Workbook): void {
  const workbook: CalcWorkbook = { Sheets: Object.create(null) };
  const formulas: { cell: Cell; projected: CalcCell }[] = [];
  let references = 0;
  for (const sheet of book.sheets) {
    const projectedSheet: Record<string, CalcCell> = Object.create(null);
    workbook.Sheets[sheet.name] = projectedSheet;
    for (const cell of sheet.cells.values()) {
      const projected: CalcCell =
        cell.formula === undefined ? { v: cell.value } : {};
      projectedSheet[cell.address] = projected;
      if (cell.formula === undefined) continue;
      if (formulas.length >= MAX_FORMULAS) fail("formula_budget_exceeded");
      references += referenceCost(sheet, admittedTokens(cell.formula));
      if (references > MAX_REFERENCED_CELLS) fail("formula_budget_exceeded");
      let reads = 0;
      const formula = cell.formula;
      // xlsx-calc has incomplete multi-node cycle detection. A valid formula is read twice by
      // this locked API; cap repeated visits before the library can exhaust the native stack.
      Object.defineProperty(projected, "f", {
        enumerable: true,
        get: () => {
          if (++reads > MAX_FORMULA_READS) fail("formula_cycle");
          return formula;
        },
      });
      formulas.push({ cell, projected });
    }
  }
  try {
    calculate(workbook, { continue_after_error: false, log_error: false });
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    if (error instanceof Error && error.message.includes("Circular ref"))
      fail("formula_cycle");
    if (error instanceof RangeError) fail("formula_depth_exceeded");
    fail("formula_unsupported");
  }
  // Calculation may encode errors as cells rather than throw. Validate all results before
  // mutating the original workbook, so an error cannot leave partially refreshed caches.
  for (const { projected } of formulas) {
    if (projected.t === "e") {
      if (projected.w === "#DIV/0!") fail("formula_division_by_zero");
      fail("formula_error");
    }
    // The admitted numeric grammar can return null only for a blank scalar reference.
    if (projected.v === null) projected.v = 0;
    if (typeof projected.v !== "number") fail("formula_non_numeric");
    if (!Number.isFinite(projected.v)) fail("formula_non_finite");
  }
  for (const { cell, projected } of formulas)
    cell.value = projected.v as number;
  book.formulaCount = formulas.length;
}
