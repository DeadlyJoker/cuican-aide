import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { DELIVERY_LIMITS, XLSX_MEDIA_TYPE } from "@crewon/domain";
import {
  readCellStyle,
  readWorksheetLayout,
  readRichText,
} from "./spreadsheet-semantics.test-support.ts";
import { SpreadsheetEngine } from "./spreadsheet-engine.ts";
import {
  exampleWorkbook,
  orderInputA,
  orderInputB,
  orderTemplate,
} from "./spreadsheet-fixture.ts";

const engine = new SpreadsheetEngine();
const file = (content = exampleWorkbook()) => ({
  inputId: "template",
  mediaType: XLSX_MEDIA_TYPE,
  content,
});
const csv = (content: string, inputId = "csv") => ({
  inputId,
  mediaType: "text/csv" as const,
  content: strToU8(content),
});
const reader = createRequire(
  new URL("../../../apps/crewon-ui/package.json", import.meta.url),
)("xlsx") as {
  read: (
    content: Uint8Array,
    options: Record<string, unknown>,
  ) => {
    Props?: Record<string, unknown>;
    Sheets: Record<
      string,
      Record<string, { v: unknown; f?: string; s?: unknown; z?: string }>
    >;
  };
};

test("F01-R01 full CSV handles quoted commas, escaped quotes, newlines, trailing empty cells and UTF-8", async () => {
  const input = csv(
    '\uFEFFid,note,amount,empty\r\n1,"a,b",3,\r\n2,"say ""yes""\nsecond line",4,\r\n',
  );
  assert.deepEqual((await engine.inspect(input)).sheets, [
    { name: "CSV", rows: 3, columns: 4 },
  ]);
  assert.deepEqual(
    (await engine.readPage(input, { sheet: "CSV", startRow: 1, limit: 100 }))
      .rows,
    [
      ["id", "note", "amount", "empty"],
      [1, "a,b", 3, null],
      [2, 'say "yes"\nsecond line', 4, null],
    ],
  );
  await assert.rejects(
    engine.inspect(csv('a,"unclosed')),
    /spreadsheet_csv_invalid/,
  );
  await assert.rejects(
    engine.inspect(csv('a,"closed"junk')),
    /spreadsheet_csv_invalid/,
  );
  await assert.rejects(
    engine.inspect({ ...csv(""), content: new Uint8Array([0xff]) }),
    /spreadsheet_utf8_invalid/,
  );
});

test("F01-R01 reads fourth worksheet and continues beyond bounded model page without truncation", async () => {
  const input = file();
  assert.equal((await engine.inspect(input)).sheets.length, 4);
  assert.deepEqual(
    (await engine.readPage(input, { sheet: "Fourth", startRow: 1, limit: 100 }))
      .rows,
    [
      ["id", "amount"],
      ["fourth-row", 7],
    ],
  );
  const long = csv(
    `id,note\n${Array.from({ length: 180 }, (_, i) => `${i},${"字".repeat(100)}`).join("\n")}`,
  );
  let startRow: number | null = 1;
  const all: unknown[] = [];
  while (startRow !== null) {
    const page = await engine.readPage(long, {
      sheet: "CSV",
      startRow,
      limit: 100,
    });
    assert.ok(
      Buffer.byteLength(JSON.stringify(page)) <= DELIVERY_LIMITS.pageBytes,
    );
    all.push(...page.rows);
    startRow = page.nextRow;
  }
  assert.equal(all.length, 181);
});

test("F01-R02/R03 assembles all selected source rows and verifies totals, formulas and preserved formatting with an independent XLSX reader", async () => {
  const template = file();
  const output = await engine.assemble({
    template,
    sources: [csv("id,amount\nA,10\nB,20\n,\n"), file()],
    request: {
      templateInputId: "template",
      name: "delivery.xlsx",
      sources: [
        { inputId: "csv", sheet: "CSV", headerRow: 1 },
        { inputId: "template", sheet: "Fourth", headerRow: 1 },
      ],
      targetSheet: "Report",
      startRow: 2,
      columns: [
        { sourceHeader: "id", targetColumn: "A" },
        { sourceHeader: "amount", targetColumn: "B" },
      ],
    },
  });
  assert.deepEqual(output.validation.sources, [
    {
      inputId: "csv",
      sheet: "CSV",
      readRows: 3,
      writtenRows: 2,
      excludedBlankRows: 1,
    },
    {
      inputId: "template",
      sheet: "Fourth",
      readRows: 1,
      writtenRows: 1,
      excludedBlankRows: 0,
    },
  ]);
  assert.equal(output.validation.writtenRows, 3);
  assert.deepEqual(output.validation.numericTotals, { B: 37 });
  const read = reader.read(output.content, { type: "array", cellStyles: true });
  assert.equal(read.Sheets.Report.A4.v, "fourth-row");
  assert.equal(read.Sheets.Report.B4.v, 7);
  assert.equal(read.Sheets.Report.B10.v, 37);
  assert.equal(read.Sheets.Report.B10.f, "SUM(B2:B9)");
  assert.equal(read.Sheets.Report.C10.v, 74);
  assert.equal(read.Sheets.Report.D1.v, "Manual note");
  const before = reader.read(template.content, {
    type: "array",
    cellStyles: true,
    cellNF: true,
  });
  const after = reader.read(output.content, {
    type: "array",
    cellStyles: true,
    cellNF: true,
  });
  for (const [name, path] of [
    ["Second", "xl/worksheets/sheet2.xml"],
    ["Third", "xl/worksheets/sheet3.xml"],
    ["Fourth", "xl/worksheets/sheet4.xml"],
  ]) {
    for (const [key, cell] of Object.entries(before.Sheets[name]).filter(
      ([key]) => !key.startsWith("!"),
    )) {
      assert.equal(after.Sheets[name][key]?.v, cell.v, `${name}!${key} value`);
      assert.equal(
        after.Sheets[name][key]?.f,
        cell.f,
        `${name}!${key} formula`,
      );
      assert.deepEqual(
        readCellStyle(output.content, path, key),
        readCellStyle(template.content, path, key),
        `${name}!${key} style`,
      );
    }
    assert.deepEqual(
      readWorksheetLayout(output.content, path),
      readWorksheetLayout(template.content, path),
      `${name} layout`,
    );
  }
  assert.deepEqual(
    readWorksheetLayout(output.content, "xl/worksheets/sheet1.xml"),
    readWorksheetLayout(template.content, "xl/worksheets/sheet1.xml"),
  );
  assert.deepEqual(
    readCellStyle(output.content, "xl/worksheets/sheet1.xml", "B2"),
    readCellStyle(template.content, "xl/worksheets/sheet1.xml", "B2"),
  );
  const richStyle = readCellStyle(
    output.content,
    "xl/worksheets/sheet2.xml",
    "B2",
  );
  assert.deepEqual(richStyle.font.color, { rgb: "FF183153" });
  assert.deepEqual(richStyle.fill.patternFill, {
    patternType: "solid",
    fgColor: { rgb: "FFE7F0FF" },
    bgColor: { indexed: "64" },
  });
  assert.deepEqual(richStyle.alignment, {
    horizontal: "center",
    vertical: "center",
    wrapText: "1",
  });
  assert.deepEqual(richStyle.border.left, {
    style: "thin",
    color: { rgb: "FF006699" },
  });
  for (const property of [
    "Author",
    "Title",
    "Subject",
    "Comments",
    "LastAuthor",
    "CreatedDate",
    "ModifiedDate",
  ])
    assert.deepEqual(
      after.Props?.[property],
      before.Props?.[property],
      property,
    );
  assert.equal(after.Props?.Author, "F01 fixture author");
  assert.equal(after.Props?.Title, "Quarterly delivery");
});

test("F01-R05 targeted patches preserve previous human values, styles and formula semantics", async () => {
  const first = await engine.patch({
    file: file(),
    patches: [{ sheet: "Report", cell: "D1", value: "edited by user" }],
  });
  const next = await engine.patch({
    file: file(first.content),
    patches: [
      { sheet: "Report", cell: "B2", value: 5 },
      { sheet: "Report", cell: "C2", value: { formula: "(B2+3)*2" } },
    ],
  });
  const independent = reader.read(next.content, { type: "array" });
  assert.equal(independent.Sheets.Report.D1.v, "edited by user");
  assert.equal(independent.Sheets.Report.C2.v, 16);
  assert.equal(independent.Sheets.Report.B10.v, 5);
  assert.deepEqual(
    readCellStyle(next.content, "xl/worksheets/sheet1.xml", "B2"),
    readCellStyle(file().content, "xl/worksheets/sheet1.xml", "B2"),
  );
  await assert.rejects(
    engine.patch({
      file: file(),
      patches: [{ sheet: "Report", cell: "E1", value: "merged subordinate" }],
    }),
    /spreadsheet_merged_cell_write/,
  );
});

test("F01-R02 rejects unsupported structures and formula errors instead of trusting cached values", async () => {
  for (const part of [
    "xl/vbaProject.bin",
    "xl/pivotTables/pivotTable1.xml",
    "xl/externalLinks/externalLink1.xml",
    "xl/drawings/drawing1.xml",
    "xl/tables/table1.xml",
  ]) {
    const zip = unzipSync(exampleWorkbook());
    zip[part] = strToU8("unsupported");
    await assert.rejects(
      engine.inspect(file(zipSync(zip))),
      /spreadsheet_unsupported_part/,
    );
  }
  for (const [formula, code] of [
    ["VLOOKUP(A1,A1:B9,2,0)", "formula_unsupported"],
    ["B2/0", "formula_division_by_zero"],
    ["B10", "formula_cycle"],
  ]) {
    const zip = unzipSync(exampleWorkbook());
    zip["xl/worksheets/sheet1.xml"] = strToU8(
      strFromU8(zip["xl/worksheets/sheet1.xml"]).replace("SUM(B2:B9)", formula),
    );
    await assert.rejects(engine.inspect(file(zipSync(zip))), new RegExp(code));
  }
});

test("F01-R08 refuses excessive rows, columns, cells, page sizes and ZIP expansion before processing", async () => {
  await assert.rejects(
    engine.inspect(csv("x\n".repeat(DELIVERY_LIMITS.rows + 1))),
    /spreadsheet_rows_exceeded/,
  );
  await assert.rejects(
    engine.inspect(
      csv(
        Array.from({ length: DELIVERY_LIMITS.columns + 1 }, () => "x").join(
          ",",
        ),
      ),
    ),
    /spreadsheet_columns_exceeded/,
  );
  await assert.rejects(
    engine.readPage(csv("x".repeat(DELIVERY_LIMITS.pageBytes)), {
      sheet: "CSV",
      startRow: 1,
      limit: 1,
    }),
    /spreadsheet_page_row_too_large/,
  );
  await assert.rejects(
    engine.readPage(csv("x"), { sheet: "CSV", startRow: 0, limit: 1 }),
    /spreadsheet_page_invalid/,
  );
  const parts = unzipSync(exampleWorkbook());
  parts["docProps/core.xml"] = new Uint8Array(
    DELIVERY_LIMITS.expandedBytes + 1,
  );
  await assert.rejects(
    engine.inspect(file(zipSync(parts))),
    /spreadsheet_expanded_bytes_exceeded/,
  );
});

test("F01-R03 missing/duplicate headers, duplicate mappings and overwrite of manual template content fail closed", async () => {
  const request = {
    templateInputId: "template",
    name: "report.xlsx",
    sources: [{ inputId: "csv", sheet: "CSV", headerRow: 1 }],
    targetSheet: "Report",
    startRow: 2,
    columns: [{ sourceHeader: "id", targetColumn: "A" }],
  };
  for (const content of ["wrong,amount\nA,1", "id,id\nA,B"])
    await assert.rejects(
      engine.assemble({ template: file(), sources: [csv(content)], request }),
      /spreadsheet_header_invalid/,
    );
  await assert.rejects(
    engine.assemble({
      template: file(),
      sources: [csv("id\nA")],
      request: {
        ...request,
        columns: [...request.columns, ...request.columns],
      },
    }),
    /spreadsheet_mapping_invalid/,
  );
  await assert.rejects(
    engine.assemble({
      template: file(),
      sources: [csv("id\nA")],
      request: {
        ...request,
        startRow: 1,
        columns: [{ sourceHeader: "id", targetColumn: "D" }],
      },
    }),
    /spreadsheet_target_occupied/,
  );
});

test("E01 seven real input orders produce five details, one cancellation, one unchanged missing amount, three currency-safe sums and full lineage", async () => {
  const template = file(orderTemplate());
  const rules = {
    exclude: [{ header: "status", equals: "canceled" }],
    requiredHeaders: ["amount"],
    exceptionSheet: "异常",
    lineageSheet: "来源",
    summary: {
      sheet: "汇总",
      startRow: 2,
      groupBy: ["channel", "currency"],
      valueHeader: "amount",
    },
  };
  const request = {
    templateInputId: "template",
    name: "orders.xlsx",
    sources: [
      { inputId: "a", sheet: "CSV", headerRow: 1 },
      { inputId: "b", sheet: "CSV", headerRow: 1 },
    ],
    targetSheet: "明细",
    startRow: 2,
    columns: ["order_id", "channel", "currency", "amount", "status"].map(
      (sourceHeader, index) => ({
        sourceHeader,
        targetColumn: String.fromCharCode(65 + index),
      }),
    ),
    rules,
  };
  const sources = [csv(orderInputA, "a"), csv(orderInputB, "b")];
  const output = await engine.assemble({ template, sources, request });
  assert.equal(output.validation.writtenRows, 5);
  assert.equal(
    output.validation.sources.reduce((sum, s) => sum + s.readRows, 0),
    7,
  );
  assert.equal(
    output.validation.sources.reduce(
      (sum, s) => sum + (s.excludedRuleRows ?? 0),
      0,
    ),
    1,
  );
  assert.equal(
    output.validation.sources.reduce(
      (sum, s) => sum + (s.exceptionRows ?? 0),
      0,
    ),
    1,
  );
  const actual = reader.read(output.content, {
    type: "array",
    cellStyles: true,
  });
  assert.deepEqual(
    [2, 3, 4].map((row) => [
      actual.Sheets["汇总"][`A${row}`].v,
      actual.Sheets["汇总"][`B${row}`].v,
      actual.Sheets["汇总"][`C${row}`].v,
    ]),
    [
      ["直营", "CNY", 180],
      ["直营", "USD", 10],
      ["渠道", "CNY", 150],
    ],
  );
  assert.equal(actual.Sheets["汇总"].D2.v, 180);
  assert.equal(actual.Sheets["明细"].H1.v, "用户原始备注");
  assert.equal(actual.Sheets["异常"].E2.v, "B002");
  assert.equal(actual.Sheets["异常"].H2?.v, undefined);
  assert.deepEqual(
    [2, 3, 4, 5, 6, 7, 8].map((row) => actual.Sheets["来源"][`D${row}`].v),
    [
      "written",
      "excluded_rule",
      "written",
      "written",
      "written",
      "exception",
      "written",
    ],
  );
  assert.equal(actual.Sheets["来源"].A7.v, "b");
  assert.equal(actual.Sheets["来源"].C7.v, 3);
  await assert.rejects(
    engine.assemble({
      template,
      sources,
      request: {
        ...request,
        rules: {
          ...rules,
          summary: { ...rules.summary, groupBy: ["channel"] },
        },
      },
    }),
    /spreadsheet_currency_group_required/,
  );
});

test("E02 amount precision patch preserves manual note and every other semantic style property", async () => {
  const note = await engine.patch({
    file: file(orderTemplate()),
    patches: [{ sheet: "明细", cell: "H1", value: "已核对渠道口径" }],
  });
  const formatted = await engine.patch({
    file: file(note.content),
    patches: [{ sheet: "明细", cell: "D2", value: 100, numberFormat: "0.0" }],
  });
  const actual = reader.read(formatted.content, {
    type: "array",
    cellStyles: true,
    cellNF: true,
  });
  assert.equal(actual.Sheets["明细"].D2.v, 100);
  assert.equal(actual.Sheets["明细"].D2.z, "0.0");
  assert.equal(actual.Sheets["明细"].H1.v, "已核对渠道口径");
  const beforeStyle = readCellStyle(
    note.content,
    "xl/worksheets/sheet1.xml",
    "D2",
  );
  const afterStyle = readCellStyle(
    formatted.content,
    "xl/worksheets/sheet1.xml",
    "D2",
  );
  assert.equal(afterStyle.numberFormat, "0.0");
  assert.deepEqual(
    { ...afterStyle, numberFormat: beforeStyle.numberFormat },
    beforeStyle,
  );
  assert.deepEqual(
    readWorksheetLayout(formatted.content, "xl/worksheets/sheet1.xml"),
    readWorksheetLayout(note.content, "xl/worksheets/sheet1.xml"),
  );
  assert.equal(
    reader.read(note.content, { type: "array" }).Sheets["明细"].D2?.v,
    undefined,
  );
});

test("F01-R02 untouched rich text content and emphasis survive mature-library reserialization", async () => {
  const parts = unzipSync(exampleWorkbook());
  const rich =
    "<is><r><rPr><b/></rPr><t>Manual </t></r><r><t>note</t></r></is>";
  parts["xl/worksheets/sheet1.xml"] = strToU8(
    strFromU8(parts["xl/worksheets/sheet1.xml"]).replace(
      "<is><t>Manual note</t></is>",
      rich,
    ),
  );
  const result = await engine.patch({
    file: file(zipSync(parts)),
    patches: [{ sheet: "Report", cell: "B2", value: 2 }],
  });
  assert.deepEqual(
    readRichText(result.content, "xl/worksheets/sheet1.xml", "D1"),
    readRichText(zipSync(parts), "xl/worksheets/sheet1.xml", "D1"),
  );
  assert.deepEqual(
    readRichText(result.content, "xl/worksheets/sheet1.xml", "D1"),
    [
      { text: "Manual ", properties: { b: "" } },
      { text: "note", properties: {} },
    ],
  );
  assert.equal(
    reader.read(result.content, { type: "array" }).Sheets.Report.D1.v,
    "Manual note",
  );
});

test("F01-R02 rejects external relationships, shared formulas and XML entity declarations", async () => {
  const external = unzipSync(exampleWorkbook());
  external["xl/_rels/workbook.xml.rels"] = strToU8(
    strFromU8(external["xl/_rels/workbook.xml.rels"]).replace(
      'Target="styles.xml"',
      'Target="https://example.invalid/style.xml" TargetMode="External"',
    ),
  );
  await assert.rejects(
    engine.inspect(file(zipSync(external))),
    /spreadsheet_external_relationship_unsupported/,
  );
  const shared = unzipSync(exampleWorkbook());
  shared["xl/worksheets/sheet1.xml"] = strToU8(
    strFromU8(shared["xl/worksheets/sheet1.xml"]).replace(
      "<f>SUM",
      '<f t="shared" si="0">SUM',
    ),
  );
  await assert.rejects(
    engine.inspect(file(zipSync(shared))),
    /spreadsheet_formula_structure_unsupported/,
  );
  const entity = unzipSync(exampleWorkbook());
  entity["xl/workbook.xml"] = strToU8(
    '<!DOCTYPE workbook [<!ENTITY secret SYSTEM "file:///secret">]>' +
      strFromU8(entity["xl/workbook.xml"]),
  );
  await assert.rejects(
    engine.inspect(file(zipSync(entity))),
    /spreadsheet_xml_entities_unsupported/,
  );
});
