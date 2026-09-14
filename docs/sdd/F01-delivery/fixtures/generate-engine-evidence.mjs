import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  readCellStyle,
  readWorksheetLayout,
} from "../../../../packages/artifacts/src/spreadsheet-semantics.test-support.ts";
import { SpreadsheetEngine } from "../../../../packages/artifacts/src/spreadsheet-engine.ts";
import {
  exampleWorkbook,
  orderTemplate,
  orderInputA,
  orderInputB,
} from "../../../../packages/artifacts/src/spreadsheet-fixture.ts";
const dir = new URL("./", import.meta.url);
const mediaType =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const engine = new SpreadsheetEngine();
const request = {
  templateInputId: "template",
  name: "orders-delivery.xlsx",
  sources: [
    { inputId: "a", sheet: "CSV", headerRow: 1 },
    { inputId: "b", sheet: "CSV", headerRow: 1 },
  ],
  targetSheet: "明细",
  startRow: 2,
  columns: ["order_id", "channel", "currency", "amount", "status"].map(
    (sourceHeader, i) => ({
      sourceHeader,
      targetColumn: String.fromCharCode(65 + i),
    }),
  ),
  rules: {
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
  },
};
const sources = [
  { inputId: "a", mediaType: "text/csv", content: Buffer.from(orderInputA) },
  { inputId: "b", mediaType: "text/csv", content: Buffer.from(orderInputB) },
];
const template = { inputId: "template", mediaType, content: orderTemplate() };
const assembled = await engine.assemble({ template, sources, request });
const noted = await engine.patch({
  file: { inputId: "output", mediaType, content: assembled.content },
  patches: [{ sheet: "明细", cell: "H1", value: "已核对渠道口径" }],
});
const precise = await engine.patch({
  file: { inputId: "output", mediaType, content: noted.content },
  patches: [{ sheet: "明细", cell: "D2", value: 100, numberFormat: "0.0" }],
});
const files = {
  "orders-a.csv": Buffer.from(orderInputA),
  "orders-b.csv": Buffer.from(orderInputB),
  "ordinary-template.xlsx": exampleWorkbook(),
  "orders-template.xlsx": template.content,
  "orders-delivery.xlsx": assembled.content,
  "orders-noted.xlsx": noted.content,
  "orders-precision.xlsx": precise.content,
};
for (const [name, content] of Object.entries(files))
  writeFileSync(new URL(name, dir), content);
writeFileSync(
  new URL("orders-request.json", dir),
  JSON.stringify(request, null, 2) + "\n",
);
const XLSX = createRequire(
  new URL("../../../../apps/crewon-ui/package.json", import.meta.url),
)("xlsx");
const workbook = XLSX.read(
  readFileSync(new URL("orders-precision.xlsx", dir)),
  { type: "buffer", cellNF: true },
);
const summary = XLSX.utils.sheet_to_json(workbook.Sheets["汇总"]);
const manifest = {
  environment: {
    node: process.version,
    writer: "ExcelJS 4.4.0",
    csvParser: "csv-parse 7.0.2",
    formulaEvaluator: "xlsx-calc 0.9.2",
    independentReader: `xlsx ${XLSX.version}`,
    synthetic: true,
    path: "SpreadsheetEngine actual bytes; no model/GUI/store claim",
  },
  files: Object.fromEntries(
    Object.entries(files).map(([name, bytes]) => [
      name,
      {
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ]),
  ),
  validation: assembled.validation,
  independentRead: {
    summary,
    exceptionRows: XLSX.utils.sheet_to_json(workbook.Sheets["异常"], {
      defval: null,
    }),
    lineage: XLSX.utils.sheet_to_json(workbook.Sheets["来源"], {
      defval: null,
    }),
    note: workbook.Sheets["明细"].H1.v,
    amount: workbook.Sheets["明细"].D2.v,
    amountFormat: workbook.Sheets["明细"].D2.z,
    amountStyle: readCellStyle(
      precise.content,
      "xl/worksheets/sheet1.xml",
      "D2",
    ),
    detailLayout: readWorksheetLayout(
      precise.content,
      "xl/worksheets/sheet1.xml",
    ),
    coreProperties: workbook.Props,
    formula: workbook.Sheets["汇总"].D2.f,
    formulaCache: workbook.Sheets["汇总"].D2.v,
  },
};
writeFileSync(
  new URL("engine-manifest.json", dir),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    files: Object.keys(files),
    validation: manifest.validation,
    summary,
    numberFormat: manifest.independentRead.amountFormat,
  }),
);
