import { XMLParser } from "fast-xml-parser";
import { strFromU8, unzipSync } from "fflate";

// Independent file-level oracle: resolves semantic style properties, never compares ZIP bytes or style indexes.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
});
type Xml = Record<string, unknown>;
function object(value: unknown): Xml {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Xml)
    : {};
}
function array(value: unknown): Xml[] {
  return (
    value === undefined ? [] : Array.isArray(value) ? value : [value]
  ).map(object);
}
function parse(content: Uint8Array): Xml {
  return parser.parse(strFromU8(content)) as Xml;
}
function cells(content: Uint8Array, sheetPath: string): Map<string, Xml> {
  const parts = unzipSync(content);
  const root = object(parse(parts[sheetPath]).worksheet);
  return new Map(
    array(object(root.sheetData).row).flatMap((row) =>
      array(row.c).map((cell) => [String(cell.r), cell] as const),
    ),
  );
}
export function readCellStyle(
  content: Uint8Array,
  sheetPath: string,
  address: string,
) {
  const parts = unzipSync(content);
  const styles = object(parse(parts["xl/styles.xml"]).styleSheet);
  const cell = cells(content, sheetPath).get(address);
  const xf = array(object(styles.cellXfs).xf)[Number(cell?.s ?? 0)] ?? {};
  const font = array(object(styles.fonts).font)[Number(xf.fontId ?? 0)] ?? {};
  const fill = array(object(styles.fills).fill)[Number(xf.fillId ?? 0)] ?? {};
  const border =
    array(object(styles.borders).border)[Number(xf.borderId ?? 0)] ?? {};
  const custom = array(object(styles.numFmts).numFmt).find(
    (entry) => String(entry.numFmtId) === String(xf.numFmtId),
  );
  const builtin: Record<string, string> = {
    "0": "General",
    "1": "0",
    "2": "0.00",
    "4": "#,##0.00",
  };
  return {
    font,
    fill,
    border,
    alignment: object(xf.alignment),
    protection: object(xf.protection),
    numberFormat:
      custom?.formatCode ??
      builtin[String(xf.numFmtId ?? 0)] ??
      `builtin:${String(xf.numFmtId)}`,
  };
}
export function readWorksheetLayout(content: Uint8Array, sheetPath: string) {
  const parts = unzipSync(content);
  const sheet = object(parse(parts[sheetPath]).worksheet);
  return {
    merges: array(object(sheet.mergeCells).mergeCell)
      .map((entry) => String(entry.ref))
      .sort(),
    columns: array(object(sheet.cols).col).map((entry) => ({
      min: Number(entry.min),
      max: Number(entry.max),
      width: entry.width === undefined ? null : Number(entry.width),
      hidden: entry.hidden === "1",
    })),
    rows: array(object(sheet.sheetData).row)
      .filter((entry) => entry.ht !== undefined || entry.hidden === "1")
      .map((entry) => ({
        row: Number(entry.r),
        height: entry.ht === undefined ? null : Number(entry.ht),
        hidden: entry.hidden === "1",
      })),
  };
}
export function readRichText(
  content: Uint8Array,
  sheetPath: string,
  address: string,
) {
  const parts = unzipSync(content);
  const cell = cells(content, sheetPath).get(address) ?? {};
  const value =
    cell.t === "s"
      ? array(object(parse(parts["xl/sharedStrings.xml"]).sst).si)[
          Number(cell.v)
        ]
      : object(cell.is);
  return array(value?.r).map((run) => ({
    text: typeof run.t === "object" ? object(run.t)["#text"] : run.t,
    properties: object(run.rPr),
  }));
}
