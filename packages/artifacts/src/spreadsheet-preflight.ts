import { XMLParser } from "fast-xml-parser";
import { DELIVERY_LIMITS } from "@crewon/domain";
import {
  attrs,
  children,
  elements,
  fail,
  utf8,
  type XmlNode,
} from "./spreadsheet-data.ts";

/** ExcelJS expands merge ranges into cells, so sparse merge XML needs a separate allocation bound. */
export const SPREADSHEET_MERGE_EXPANSION_LIMIT = 100_000;
export const SPREADSHEET_MERGE_RANGE_LIMIT = 1024;
export const SPREADSHEET_SHEET_ID_LIMIT = 100_000;
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
});
function coordinate(value: string): { row: number; column: number } {
  const match = /^([A-Z]+)([1-9][0-9]*)$/u.exec(value);
  if (!match) fail("cell_invalid");
  const row = Number(match[2]);
  if (!Number.isSafeInteger(row) || row > DELIVERY_LIMITS.rows)
    fail("rows_exceeded");
  if (match[1].length > 3) fail("columns_exceeded");
  const column = [...match[1]].reduce(
    (total, char) => total * 26 + char.charCodeAt(0) - 64,
    0,
  );
  if (column > DELIVERY_LIMITS.columns) fail("columns_exceeded");
  return { row, column };
}
function positiveInteger(
  value: string | undefined,
  maximum: number,
  code: string,
): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) fail(code);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) fail(code);
  return number;
}
function range(
  value: string,
  requirePair = false,
): {
  first: ReturnType<typeof coordinate>;
  last: ReturnType<typeof coordinate>;
} {
  const parts = value.split(":");
  if (parts.length > 2 || (requirePair && parts.length !== 2))
    fail("range_invalid");
  const first = coordinate(parts[0]);
  const last = coordinate(parts.at(-1)!);
  if (first.row > last.row || first.column > last.column) fail("range_invalid");
  return { first, last };
}
/** Only structural admission. Mature ExcelJS still owns all value, style and workbook loading/serialization. */
export function preflightSpreadsheetCoordinates(
  parts: Readonly<Record<string, Uint8Array>>,
): void {
  const worksheets = Object.entries(parts).filter(([name]) =>
    /^xl\/worksheets\/sheet[0-9]+\.xml$/u.test(name),
  );
  if (worksheets.length === 0 || worksheets.length > 256) fail("sheet_invalid");
  const workbookBytes = parts["xl/workbook.xml"];
  if (!workbookBytes) fail("package_invalid");
  const workbookRoot = elements(
    parser.parse(utf8(workbookBytes)) as XmlNode[],
    "workbook",
  );
  if (workbookRoot.length !== 1) fail("xml_root_invalid");
  const entries = elements(
    children(workbookRoot[0], "workbook"),
    "sheets",
  ).flatMap((group) => elements(children(group, "sheets"), "sheet"));
  if (entries.length === 0 || entries.length > 256) fail("sheet_invalid");
  const names = new Set<string>();
  const identifiers = new Set<number>();
  const relations = new Set<string>();
  for (const entry of entries) {
    const a = attrs(entry);
    const name = a.name?.toLowerCase();
    const relation = a["r:id"];
    const id = positiveInteger(
      a.sheetId,
      SPREADSHEET_SHEET_ID_LIMIT,
      "sheet_id_exceeded",
    );
    if (
      !name ||
      !relation ||
      names.has(name) ||
      identifiers.has(id) ||
      relations.has(relation)
    )
      fail("sheet_invalid");
    names.add(name);
    identifiers.add(id);
    relations.add(relation);
  }
  let mergedCells = 0;
  let mergeRanges = 0;
  for (const [, content] of worksheets) {
    const document = parser.parse(utf8(content)) as XmlNode[];
    const root = elements(document, "worksheet");
    if (root.length !== 1) fail("xml_root_invalid");
    const nodes = children(root[0], "worksheet");
    const dimensions = elements(nodes, "dimension");
    if (dimensions.length > 1) fail("sheet_invalid");
    for (const dimension of dimensions) range(attrs(dimension).ref ?? "");
    for (const columns of elements(nodes, "cols"))
      for (const col of elements(children(columns, "cols"), "col")) {
        const first = positiveInteger(
          attrs(col).min,
          DELIVERY_LIMITS.columns,
          "columns_exceeded",
        );
        const last = positiveInteger(
          attrs(col).max,
          DELIVERY_LIMITS.columns,
          "columns_exceeded",
        );
        if (first > last) fail("columns_exceeded");
      }
    const data = elements(nodes, "sheetData");
    if (data.length !== 1) fail("sheet_invalid");
    const seenRows = new Set<number>();
    for (const row of elements(children(data[0], "sheetData"), "row")) {
      const rowNumber = positiveInteger(
        attrs(row).r,
        DELIVERY_LIMITS.rows,
        "rows_exceeded",
      );
      if (seenRows.has(rowNumber)) fail("row_invalid");
      seenRows.add(rowNumber);
      const spans = attrs(row).spans;
      if (spans !== undefined) {
        const columns = spans.split(":");
        if (columns.length !== 2) fail("columns_exceeded");
        const first = positiveInteger(
          columns[0],
          DELIVERY_LIMITS.columns,
          "columns_exceeded",
        );
        const last = positiveInteger(
          columns[1],
          DELIVERY_LIMITS.columns,
          "columns_exceeded",
        );
        if (first > last) fail("columns_exceeded");
      }
      const seenCells = new Set<string>();
      for (const cell of elements(children(row, "row"), "c")) {
        const ref = attrs(cell).r ?? "";
        const position = coordinate(ref);
        if (position.row !== rowNumber) fail("cell_invalid");
        if (seenCells.has(ref)) fail("cell_duplicate");
        seenCells.add(ref);
      }
    }
    for (const merges of elements(nodes, "mergeCells"))
      for (const merge of elements(
        children(merges, "mergeCells"),
        "mergeCell",
      )) {
        if (++mergeRanges > SPREADSHEET_MERGE_RANGE_LIMIT)
          fail("merge_ranges_exceeded");
        const { first, last } = range(attrs(merge).ref ?? "", true);
        mergedCells +=
          (last.row - first.row + 1) * (last.column - first.column + 1);
        if (mergedCells > SPREADSHEET_MERGE_EXPANSION_LIMIT)
          fail("merge_expansion_exceeded");
      }
  }
}
