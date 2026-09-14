import type ExcelJS from "exceljs";
import { parse } from "csv-parse/sync";
import {
  DELIVERY_LIMITS,
  DeliveryError,
  type SpreadsheetCellValue,
} from "@crewon/domain";

export type XmlNode = {
  [key: string]: XmlNode[] | string | Record<string, string> | undefined;
};
export type Cell = {
  address: string;
  row: number;
  column: number;
  value: SpreadsheetCellValue;
  formula?: string;
  xml?: XmlNode;
  changed?: boolean;
};
export type Sheet = {
  name: string;
  path: string;
  rows: number;
  columns: number;
  cells: Map<string, Cell>;
  xml?: XmlNode[];
  merges: {
    first: ReturnType<typeof address>;
    last: ReturnType<typeof address>;
  }[];
  dirty: boolean;
};
export type Workbook = {
  nativeWorkbook?: ExcelJS.Workbook;
  sheets: Sheet[];
  parts: Record<string, Uint8Array> | null;
  formulaCount: number;
};
export function fail(code: string): never {
  throw new DeliveryError(`spreadsheet_${code}`);
}
export function columnName(column: number): string {
  let result = "";
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26))
    result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
  return result;
}
export function columnNumber(value: string): number {
  if (!/^[A-Z]{1,3}$/u.test(value)) fail("cell_invalid");
  const n = [...value].reduce(
    (sum, char) => sum * 26 + char.charCodeAt(0) - 64,
    0,
  );
  if (n > DELIVERY_LIMITS.columns) fail("columns_exceeded");
  return n;
}
export function address(value: string): {
  row: number;
  column: number;
  key: string;
} {
  const match = /^\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})$/u.exec(value);
  if (!match) fail("cell_invalid");
  const row = Number(match[2]);
  const column = columnNumber(match[1]);
  if (row > DELIVERY_LIMITS.rows) fail("rows_exceeded");
  return { row, column, key: `${match[1]}${row}` };
}
export function dimensions(sheet: Sheet, row: number, column: number): void {
  if (row > DELIVERY_LIMITS.rows) fail("rows_exceeded");
  if (column > DELIVERY_LIMITS.columns) fail("columns_exceeded");
  sheet.rows = Math.max(sheet.rows, row);
  sheet.columns = Math.max(sheet.columns, column);
}
export function utf8(content: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return fail("utf8_invalid");
  }
}
export function children(node: XmlNode, tag: string): XmlNode[] {
  const value = node[tag];
  return Array.isArray(value) ? value : [];
}
export function elements(nodes: XmlNode[], tag: string): XmlNode[] {
  return nodes.filter((node) => Array.isArray(node[tag]));
}
export function attrs(node: XmlNode): Record<string, string> {
  return (node[":@"] ?? {}) as Record<string, string>;
}
export function text(nodes: XmlNode[]): string {
  return nodes
    .map((node) =>
      typeof node["#text"] === "string"
        ? node["#text"]
        : Object.keys(node)
            .filter((k) => k !== ":@")
            .map((k) => text(children(node, k)))
            .join(""),
    )
    .join("");
}
export function element(
  tag: string,
  nodes: XmlNode[] = [],
  attributes?: Record<string, string>,
): XmlNode {
  return { [tag]: nodes, ...(attributes ? { ":@": attributes } : {}) };
}
export function childText(node: XmlNode, tag: string): string {
  return text(children(node, tag));
}
export function cellValue(
  sheet: Sheet,
  row: number,
  column: number,
): SpreadsheetCellValue {
  return sheet.cells.get(`${columnName(column)}${row}`)?.value ?? null;
}
export function sheetNamed(book: Workbook, name: string): Sheet {
  const sheet = book.sheets.find((s) => s.name === name);
  if (!sheet) fail("sheet_missing");
  return sheet;
}

// Only unambiguous decimal syntax becomes a number; identifiers with leading zeros remain strings.
export function csvValue(value: string): SpreadsheetCellValue {
  if (!value) return null;
  if (
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(value) &&
    Number.isFinite(Number(value)) &&
    value.replace(/[-.eE+]/gu, "").length <= 15
  )
    return Number(value);
  return value;
}
export function readCsv(content: Uint8Array): Workbook {
  const input = utf8(content);
  const sheet: Sheet = {
    name: "CSV",
    path: "",
    rows: 0,
    columns: 0,
    cells: new Map(),
    merges: [],
    dirty: false,
  };
  let records: string[][];
  try {
    records = parse(input, {
      bom: true,
      relax_column_count: true,
      max_record_size: DELIVERY_LIMITS.fileBytes,
    }) as string[][];
  } catch {
    return fail("csv_invalid");
  }
  if (records.length > DELIVERY_LIMITS.rows) fail("rows_exceeded");
  records.forEach((record, index) => {
    if (record.length > DELIVERY_LIMITS.columns) fail("columns_exceeded");
    const row = index + 1;
    dimensions(sheet, row, record.length);
    record.forEach((raw, col) => {
      const column = col + 1;
      const value = csvValue(raw);
      if (value !== null)
        sheet.cells.set(`${columnName(column)}${row}`, {
          address: `${columnName(column)}${row}`,
          row,
          column,
          value,
        });
    });
  });
  return { sheets: [sheet], parts: null, formulaCount: 0 };
}
