import { preflightSpreadsheetCoordinates } from "./spreadsheet-preflight.ts";
import ExcelJS, { type Worksheet } from "exceljs";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { unzipSync } from "fflate";
import { DELIVERY_LIMITS } from "@crewon/domain";
import {
  address,
  attrs,
  childText,
  children,
  columnName,
  dimensions,
  element,
  elements,
  fail,
  text,
  utf8,
  type Cell,
  type Sheet,
  type Workbook,
  type XmlNode,
} from "./spreadsheet-data.ts";

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const xmlOptions = {
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
};
const parser = new XMLParser(xmlOptions);
const allowedParts =
  /^(?:\[Content_Types\]\.xml|_rels\/\.rels|docProps\/(?:core|app)\.xml|xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|styles\.xml|sharedStrings\.xml|theme\/theme[0-9]+\.xml|worksheets\/sheet[0-9]+\.xml))$/u;

function parseXml(content: Uint8Array): XmlNode[] {
  const xml = utf8(content);
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) fail("xml_entities_unsupported");
  if (XMLValidator.validate(xml) !== true) fail("xml_invalid");
  try {
    return parser.parse(xml) as XmlNode[];
  } catch {
    return fail("xml_invalid");
  }
}
function root(nodes: XmlNode[], name: string): XmlNode {
  const roots = nodes.filter((node) =>
    Object.keys(node).some(
      (key) => key !== ":@" && key !== "#text" && !key.startsWith("?"),
    ),
  );
  if (roots.length !== 1 || !Array.isArray(roots[0][name]))
    fail("xml_root_invalid");
  return roots[0];
}
function requiredPart(
  parts: Record<string, Uint8Array>,
  name: string,
): Uint8Array {
  const part = parts[name];
  if (!part) fail("package_invalid");
  return part;
}
function rejectTags(nodes: XmlNode[], unsupported: Set<string>): void {
  for (const node of nodes)
    for (const [key, value] of Object.entries(node)) {
      if (unsupported.has(key)) fail("unsupported_structure");
      if (Array.isArray(value)) rejectTags(value, unsupported);
    }
}
function validateRelationships(
  parts: Record<string, Uint8Array>,
): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const name of ["_rels/.rels", "xl/_rels/workbook.xml.rels"]) {
    const relationships = children(
      root(parseXml(requiredPart(parts, name)), "Relationships"),
      "Relationships",
    );
    const ids = new Set<string>();
    for (const relation of elements(relationships, "Relationship")) {
      const a = attrs(relation);
      if (!a.Id || ids.has(a.Id) || !a.Target || !a.Type)
        fail("relationship_invalid");
      ids.add(a.Id);
      if (a.TargetMode !== undefined && a.TargetMode !== "Internal")
        fail("external_relationship_unsupported");
      const supported = [
        "worksheet",
        "styles",
        "sharedStrings",
        "theme",
        "officeDocument",
        "extended-properties",
      ].map((t) => REL + t);
      supported.push(
        "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
      );
      if (!supported.includes(a.Type)) fail("relationship_unsupported");
      if (/[:\\?#]/u.test(a.Target) || a.Target.split("/").includes(".."))
        fail("relationship_invalid");
      const path = a.Target.startsWith("/")
        ? a.Target.slice(1)
        : (name.startsWith("xl/") ? "xl/" : "") +
          a.Target.replace(/^\.\//u, "");
      requiredPart(parts, path);
      if (name.startsWith("xl/") && a.Type === REL + "worksheet")
        mapping.set(a.Id, path);
      if (
        name === "_rels/.rels" &&
        a.Type === REL + "officeDocument" &&
        path !== "xl/workbook.xml"
      )
        fail("package_invalid");
    }
  }
  return mapping;
}
/** ExcelJS owns cell types, shared strings and formula models; XML validates persisted numeric caches. */
function readCell(node: XmlNode, native: Worksheet, rowNumber: number): Cell {
  const a = attrs(node);
  const ref = address(a.r ?? "");
  if (ref.row !== rowNumber || a.cm !== undefined || a.vm !== undefined)
    fail("cell_invalid");
  const nodes = children(node, "c");
  if (
    nodes.some((n) =>
      Object.keys(n).some(
        (tag) => !["f", "v", "is", "#text", ":@"].includes(tag),
      ),
    )
  )
    fail("cell_structure_unsupported");
  const formulas = elements(nodes, "f");
  const values = elements(nodes, "v");
  const inline = elements(nodes, "is");
  if (
    formulas.length > 1 ||
    values.length > 1 ||
    inline.length > 1 ||
    (values.length && inline.length)
  )
    fail("cell_invalid");
  if (
    formulas.length &&
    (Object.keys(attrs(formulas[0])).length ||
      inline.length ||
      ![undefined, "n"].includes(a.t))
  )
    fail("formula_structure_unsupported");
  const source = native.getCell(ref.key);
  // A merged subordinate aliases its master's value in ExcelJS; it is not a second stored value.
  const raw = source.type === ExcelJS.ValueType.Merge ? null : source.value;
  let value: Cell["value"] = null;
  let formula: string | undefined;
  if (raw === null || raw === undefined) value = null;
  else if (
    typeof raw === "string" ||
    typeof raw === "boolean" ||
    typeof raw === "number"
  )
    value = raw;
  else if (raw instanceof Date) {
    // Preserve Excel's stored serial, including its workbook date epoch, when ExcelJS recognizes a date.
    value = Number(values.length ? childText(values[0], "v") : "NaN");
  } else if ("formula" in raw) {
    formula = raw.formula;
    // ExcelJS 4.4 drops a zero result in its public getter. Verify the serialized
    // numeric cache directly, including zero, before any recalculation occurs.
    const cached = values.length ? childText(values[0], "v").trim() : "";
    value = cached === "" ? null : Number(cached);
  } else if ("richText" in raw) value = source.text;
  else if ("error" in raw) fail("cell_error");
  else fail("cell_type_unsupported");
  if (typeof value === "number" && !Number.isFinite(value))
    fail("cell_invalid");
  if (formulas.length && !formula) fail("formula_unsupported");
  return {
    address: ref.key,
    row: ref.row,
    column: ref.column,
    value,
    ...(formula !== undefined ? { formula } : {}),
    xml: node,
  };
}
function readSheet(
  name: string,
  path: string,
  parts: Record<string, Uint8Array>,
  native: Worksheet,
): Sheet {
  const xml = parseXml(requiredPart(parts, path));
  const worksheet = root(xml, "worksheet");
  if (attrs(worksheet).xmlns !== MAIN) fail("namespace_unsupported");
  const nodes = children(worksheet, "worksheet");
  const supported = new Set([
    "sheetPr",
    "dimension",
    "sheetViews",
    "sheetFormatPr",
    "cols",
    "sheetData",
    "mergeCells",
    "printOptions",
    "pageMargins",
    "pageSetup",
    "headerFooter",
    "autoFilter",
    "#text",
  ]);
  for (const node of nodes)
    for (const tag of Object.keys(node))
      if (tag !== ":@" && !supported.has(tag)) fail("unsupported_structure");
  const sheet: Sheet = {
    name,
    path,
    rows: 0,
    columns: 0,
    cells: new Map(),
    xml,
    merges: [],
    dirty: false,
  };
  const dimension = elements(nodes, "dimension");
  if (dimension.length > 1) fail("sheet_invalid");
  if (dimension.length && attrs(dimension[0]).ref) {
    const range = attrs(dimension[0]).ref.split(":");
    if (range.length > 2) fail("sheet_invalid");
    const end = address(range.at(-1)!);
    dimensions(sheet, end.row, end.column);
  }
  const data = elements(nodes, "sheetData");
  if (data.length !== 1) fail("sheet_invalid");
  const seenRows = new Set<number>();
  for (const row of elements(children(data[0], "sheetData"), "row")) {
    const rawRow = attrs(row).r;
    if (!/^[1-9]\d*$/u.test(rawRow ?? "")) fail("row_invalid");
    const rowNumber = Number(rawRow);
    if (seenRows.has(rowNumber)) fail("row_invalid");
    seenRows.add(rowNumber);
    dimensions(sheet, rowNumber, 0);
    for (const node of elements(children(row, "row"), "c")) {
      const cell = readCell(node, native, rowNumber);
      if (sheet.cells.has(cell.address)) fail("cell_duplicate");
      sheet.cells.set(cell.address, cell);
      dimensions(sheet, cell.row, cell.column);
    }
  }
  for (const merges of elements(nodes, "mergeCells"))
    for (const node of elements(children(merges, "mergeCells"), "mergeCell")) {
      const range = (attrs(node).ref ?? "").split(":");
      if (range.length !== 2) fail("merge_invalid");
      const first = address(range[0]);
      const last = address(range[1]);
      if (first.row > last.row || first.column > last.column)
        fail("merge_invalid");
      sheet.merges.push({ first, last });
      dimensions(sheet, last.row, last.column);
    }
  return sheet;
}
export async function readXlsx(content: Uint8Array): Promise<Workbook> {
  let total = 0;
  const seen = new Set<string>();
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(content, {
      filter(entry) {
        if (seen.has(entry.name) || seen.size > 1024) fail("package_invalid");
        seen.add(entry.name);
        total += entry.originalSize;
        if (total > DELIVERY_LIMITS.expandedBytes)
          fail("expanded_bytes_exceeded");
        if (entry.name.endsWith("/")) return false;
        if (!allowedParts.test(entry.name)) fail("unsupported_part");
        return true;
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("spreadsheet_"))
      throw error;
    return fail("zip_invalid");
  }
  // Validate every XML part, including preserved parts, before accepting the original file.
  for (const bytes of Object.values(parts)) parseXml(bytes);
  const types = children(
    root(parseXml(requiredPart(parts, "[Content_Types].xml")), "Types"),
    "Types",
  );
  for (const node of types)
    if (
      /macroEnabled|vba|externalLink|pivot|chart/iu.test(
        attrs(node).ContentType ?? "",
      )
    )
      fail("content_type_unsupported");
  const relationships = validateRelationships(parts);
  const xml = parseXml(requiredPart(parts, "xl/workbook.xml"));
  const workbook = root(xml, "workbook");
  if (attrs(workbook).xmlns !== MAIN) fail("namespace_unsupported");
  rejectTags(
    xml,
    new Set([
      "externalReferences",
      "pivotCaches",
      "definedNames",
      "extLst",
      "workbookProtection",
      "fileSharing",
    ]),
  );
  preflightSpreadsheetCoordinates(parts);
  const native = new ExcelJS.Workbook();
  try {
    await native.xlsx.load(Buffer.from(content) as unknown as ExcelJS.Buffer);
  } catch {
    return fail("xlsx_invalid");
  }
  if (!Object.keys(parts).some((name) => name.startsWith("xl/theme/")))
    native.clearThemes();
  const sheets: Sheet[] = [];
  const seenNames = new Set<string>();
  const seenPaths = new Set<string>();
  for (const collection of elements(children(workbook, "workbook"), "sheets"))
    for (const node of elements(children(collection, "sheets"), "sheet")) {
      const a = attrs(node);
      const name = a.name;
      const path = relationships.get(a["r:id"]);
      if (
        !name ||
        !path ||
        seenNames.has(name.toLowerCase()) ||
        seenPaths.has(path)
      )
        fail("sheet_invalid");
      seenNames.add(name.toLowerCase());
      seenPaths.add(path);
      const worksheet = native.getWorksheet(name);
      if (!worksheet) fail("sheet_invalid");
      sheets.push(readSheet(name, path, parts, worksheet));
    }
  if (!sheets.length || sheets.length > 256) fail("sheet_invalid");
  if (
    Object.keys(parts).filter((name) => name.startsWith("xl/worksheets/"))
      .length !== sheets.length
  )
    fail("sheet_unreferenced");
  return { sheets, parts, formulaCount: 0, nativeWorkbook: native };
}
/** ExcelJS owns workbook serialization and styles; no custom OOXML writer. */
export async function writeXlsx(book: Workbook): Promise<Uint8Array> {
  const native = book.nativeWorkbook;
  if (!book.parts || !native) fail("template_must_be_xlsx");
  for (const sheet of book.sheets) {
    const worksheet = native.getWorksheet(sheet.name);
    if (!worksheet) fail("sheet_invalid");
    for (const cell of sheet.cells.values()) {
      if (!cell.changed && cell.formula === undefined) continue;
      worksheet.getCell(cell.address).value =
        cell.formula === undefined
          ? cell.value
          : { formula: cell.formula, result: cell.value as number };
    }
  }
  const content = new Uint8Array(await native.xlsx.writeBuffer());
  if (content.byteLength > DELIVERY_LIMITS.fileBytes)
    fail("file_bytes_exceeded");
  return content;
}

export function setNumberFormat(
  book: Workbook,
  sheet: Sheet,
  key: string,
  format: "0" | "0.0" | "0.00",
): void {
  if (!book.nativeWorkbook || !["0", "0.0", "0.00"].includes(format))
    fail("number_format_unsupported");
  const cell = book.nativeWorkbook.getWorksheet(sheet.name)?.getCell(key);
  if (!cell) fail("cell_invalid");
  cell.style = { ...cell.style, numFmt: format };
  sheet.dirty = true;
}
