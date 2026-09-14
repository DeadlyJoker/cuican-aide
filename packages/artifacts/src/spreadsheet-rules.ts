import type {
  DeliveryAssemblyRules,
  SpreadsheetCellPatch,
  SpreadsheetCellValue,
} from "@crewon/domain";
import { DELIVERY_LIMITS } from "@crewon/domain";
import {
  cellValue,
  columnName,
  fail,
  sheetNamed,
  type Sheet,
  type Workbook,
} from "./spreadsheet-data.ts";

type Writer = (
  sheet: Sheet,
  patch: SpreadsheetCellPatch,
  requireEmpty: boolean,
) => void;
type RowSource = { inputId: string; sheet: string; row: number };
export type RowStatus =
  | "written"
  | "excluded_blank"
  | "excluded_rule"
  | "exception";
type Exception = {
  source: RowSource;
  values: readonly SpreadsheetCellValue[];
  headers: readonly SpreadsheetCellValue[];
  reason: string;
};
/** Row-level provenance lives in the actual output workbook, while validation responses remain bounded counts. */
export class AssemblyRules {
  readonly #rules: DeliveryAssemblyRules;
  readonly #writer: Writer;
  readonly #lineage: Sheet;
  readonly #exceptions: Sheet;
  readonly #summary: Sheet;
  readonly #exceptionRows: Exception[] = [];
  readonly #allHeaders: string[] = [];
  readonly #groups = new Map<
    string,
    { values: SpreadsheetCellValue[]; sum: number }
  >();
  #lineageRow = 2;
  constructor(
    book: Workbook,
    targetSheet: string,
    rules: DeliveryAssemblyRules,
    writer: Writer,
  ) {
    this.#rules = rules;
    this.#writer = writer;
    if (
      new Set([
        targetSheet,
        rules.lineageSheet,
        rules.exceptionSheet,
        rules.summary.sheet,
      ]).size !== 4
    )
      fail("rules_sheet_overlap");
    this.#lineage = sheetNamed(book, rules.lineageSheet);
    this.#exceptions = sheetNamed(book, rules.exceptionSheet);
    this.#summary = sheetNamed(book, rules.summary.sheet);
    if (
      !rules.summary.groupBy.length ||
      rules.summary.groupBy.length >= DELIVERY_LIMITS.columns ||
      new Set(rules.summary.groupBy).size !== rules.summary.groupBy.length ||
      !Number.isSafeInteger(rules.summary.startRow) ||
      rules.summary.startRow < 1 ||
      rules.summary.startRow > DELIVERY_LIMITS.rows
    )
      fail("rules_invalid");
    this.#writeHeader(this.#lineage, [
      "sourceInputId",
      "sourceSheet",
      "sourceRow",
      "status",
      "outputSheet",
      "outputRow",
    ]);
  }
  #writeHeader(sheet: Sheet, headers: readonly string[]): void {
    headers.forEach((value, index) => {
      if (
        cellValue(sheet, 1, index + 1) === value &&
        sheet.cells.get(`${columnName(index + 1)}1`)?.formula === undefined
      )
        return;
      this.#writer(
        sheet,
        { sheet: sheet.name, cell: `${columnName(index + 1)}1`, value },
        true,
      );
    });
  }
  prepare(
    headers: readonly SpreadsheetCellValue[],
  ): (source: RowSource, values: readonly SpreadsheetCellValue[]) => RowStatus {
    const nonempty = headers.filter((value) => value !== null && value !== "");
    if (
      nonempty.some((value) => typeof value !== "string") ||
      new Set(nonempty).size !== nonempty.length ||
      headers.some((value) => value === null || value === "")
    )
      fail("header_invalid");
    const names = headers as readonly string[];
    for (const header of names)
      if (!this.#allHeaders.includes(header)) this.#allHeaders.push(header);
    if (this.#allHeaders.length + 4 > DELIVERY_LIMITS.columns)
      fail("columns_exceeded");
    const indexOf = (header: string): number => {
      const index = names.indexOf(header);
      if (index < 0) fail("header_invalid");
      return index;
    };
    const exclude = this.#rules.exclude.map((rule) => ({
      index: indexOf(rule.header),
      equals: rule.equals,
    }));
    const required = this.#rules.requiredHeaders.map((header) => ({
      index: indexOf(header),
      header,
    }));
    const groups = this.#rules.summary.groupBy.map(indexOf);
    const amount = indexOf(this.#rules.summary.valueHeader);
    const currency = names.find((name) => name.toLowerCase() === "currency");
    if (currency && !this.#rules.summary.groupBy.includes(currency))
      fail("currency_group_required");
    return (source, values) => {
      if (values.every((value) => value === null || value === ""))
        return "excluded_blank";
      if (exclude.some((rule) => values[rule.index] === rule.equals))
        return "excluded_rule";
      const missing = required
        .filter(
          (rule) => values[rule.index] === null || values[rule.index] === "",
        )
        .map((rule) => rule.header);
      const groupValues = groups.map((index) => values[index]);
      const value = values[amount];
      const emptyGroup = groupValues.some(
        (value) => value === null || value === "",
      );
      if (missing.length || typeof value !== "number" || emptyGroup) {
        const reason = missing.length
          ? `required value missing: ${missing.join(", ")}`
          : emptyGroup
            ? "summary group value missing"
            : `summary value is not numeric: ${this.#rules.summary.valueHeader}`;
        this.#exceptionRows.push({ source, headers, values, reason });
        return "exception";
      }
      const key = JSON.stringify(groupValues);
      const group = this.#groups.get(key) ?? { values: groupValues, sum: 0 };
      group.sum += value;
      if (!Number.isFinite(group.sum)) fail("total_non_finite");
      this.#groups.set(key, group);
      return "written";
    };
  }
  record(
    source: RowSource,
    status: RowStatus,
    targetSheet: string,
    outputRow: number | null,
  ): void {
    const values = [
      source.inputId,
      source.sheet,
      source.row,
      status,
      status === "written" ? targetSheet : null,
      outputRow,
    ];
    values.forEach((value, index) =>
      this.#writer(
        this.#lineage,
        {
          sheet: this.#lineage.name,
          cell: `${columnName(index + 1)}${this.#lineageRow}`,
          value,
        },
        true,
      ),
    );
    this.#lineageRow++;
  }
  finish(): void {
    this.#writeHeader(this.#exceptions, [
      "sourceInputId",
      "sourceSheet",
      "sourceRow",
      "reason",
      ...this.#allHeaders,
    ]);
    this.#exceptionRows.forEach((exception, index) => {
      const values = [
        exception.source.inputId,
        exception.source.sheet,
        exception.source.row,
        exception.reason,
        ...this.#allHeaders.map((header) => {
          const position = exception.headers.indexOf(header);
          return position < 0 ? null : exception.values[position];
        }),
      ];
      values.forEach((value, column) =>
        this.#writer(
          this.#exceptions,
          {
            sheet: this.#exceptions.name,
            cell: `${columnName(column + 1)}${index + 2}`,
            value,
          },
          true,
        ),
      );
    });
    let row = this.#rules.summary.startRow;
    for (const group of this.#groups.values()) {
      [...group.values, group.sum].forEach((value, index) =>
        this.#writer(
          this.#summary,
          {
            sheet: this.#summary.name,
            cell: `${columnName(index + 1)}${row}`,
            value,
          },
          true,
        ),
      );
      row++;
    }
  }
}
