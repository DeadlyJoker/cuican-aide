import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { exampleWorkbook } from "./spreadsheet-fixture.ts";
import { readXlsx } from "./spreadsheet-ooxml.ts";
import { preflightSpreadsheetCoordinates } from "./spreadsheet-preflight.ts";

const sheetPath = "xl/worksheets/sheet4.xml";
function replaceSheet(xml: string): Record<string, Uint8Array> {
  const parts = unzipSync(exampleWorkbook());
  parts[sheetPath] = strToU8(
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${xml}</worksheet>`,
  );
  return parts;
}

test("F01-R08 rejects sparse out-of-bound worksheet coordinates before invoking ExcelJS.load", async (t) => {
  const native = new ExcelJS.Workbook();
  const loadPrototype = Object.getPrototypeOf(native.xlsx) as {
    load: (input: unknown) => Promise<unknown>;
  };
  const spy = t.mock.method(loadPrototype, "load", async () => {
    throw new Error("native load must not run");
  });
  const cases: [string, string][] = [
    ['<dimension ref="A1:IV100001"/><sheetData/>', "rows_exceeded"],
    ['<dimension ref="A100001:A1"/><sheetData/>', "rows_exceeded"],
    ['<dimension ref="A1:IW1"/><sheetData/>', "columns_exceeded"],
    ['<sheetData><row r="100001"/></sheetData>', "rows_exceeded"],
    [
      '<sheetData><row r="1"><c r="A100001"/></row></sheetData>',
      "rows_exceeded",
    ],
    [
      '<sheetData><row r="1"><c r="XFD1"/></row></sheetData>',
      "columns_exceeded",
    ],
    ['<sheetData><row r="1" spans="1:16384"/></sheetData>', "columns_exceeded"],
    ['<cols><col min="1" max="16384"/></cols><sheetData/>', "columns_exceeded"],
    [
      '<sheetData/><mergeCells><mergeCell ref="A1:A1048576"/></mergeCells>',
      "rows_exceeded",
    ],
    [
      '<sheetData/><mergeCells><mergeCell ref="A1:IV100000"/></mergeCells>',
      "merge_expansion_exceeded",
    ],
    [
      '<sheetData/><mergeCells><mergeCell ref="A1:IV200"/><mergeCell ref="A201:IV400"/></mergeCells>',
      "merge_expansion_exceeded",
    ],
  ];
  for (const [xml, code] of cases)
    await assert.rejects(
      readXlsx(zipSync(replaceSheet(xml))),
      new RegExp(`spreadsheet_${code}`),
    );
  const manyMerges = `<sheetData/><mergeCells>${Array.from({ length: 1025 }, (_, i) => `<mergeCell ref="A${i + 1}:B${i + 1}"/>`).join("")}</mergeCells>`;
  await assert.rejects(
    readXlsx(zipSync(replaceSheet(manyMerges))),
    /spreadsheet_merge_ranges_exceeded/,
  );
  const sparseId = replaceSheet("<sheetData/>");
  sparseId["xl/workbook.xml"] = strToU8(
    strFromU8(sparseId["xl/workbook.xml"]).replace(
      'sheetId="4"',
      'sheetId="2147483647"',
    ),
  );
  await assert.rejects(
    readXlsx(zipSync(sparseId)),
    /spreadsheet_sheet_id_exceeded/,
  );
  assert.equal(spy.mock.callCount(), 0);
});

test("F01-R08 admits maximum ordinary sparse coordinates without constructing cells in preflight", () => {
  const parts = replaceSheet(
    '<dimension ref="A1:IV100000"/><cols><col min="256" max="256"/></cols><sheetData><row r="100000" spans="256:256"><c r="IV100000"><v>1</v></c></row></sheetData>',
  );
  assert.doesNotThrow(() => preflightSpreadsheetCoordinates(parts));
  assert.match(strFromU8(parts[sheetPath]), /IV100000/u);
});

test("F01-R08 rejects excessive worksheet count before high-level workbook allocation", () => {
  const parts = replaceSheet("<sheetData/>");
  for (let i = 5; i <= 257; i++)
    parts[`xl/worksheets/sheet${i}.xml`] = parts[sheetPath];
  assert.throws(
    () => preflightSpreadsheetCoordinates(parts),
    /spreadsheet_sheet_invalid/,
  );
});
