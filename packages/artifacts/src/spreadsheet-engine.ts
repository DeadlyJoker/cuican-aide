import type {
  SpreadsheetEnginePort,
  SpreadsheetFile,
} from "@crewon/application";
import {
  DELIVERY_LIMITS,
  XLSX_MEDIA_TYPE,
  type DeliveryAssembleRequest,
  type DeliveryValidation,
  type SpreadsheetCellPatch,
  type SpreadsheetInspection,
  type SpreadsheetPage,
} from "@crewon/domain";
import {
  address,
  cellValue,
  columnName,
  columnNumber,
  dimensions,
  fail,
  readCsv,
  sheetNamed,
  type Sheet,
  type Workbook,
} from "./spreadsheet-data.ts";
import { evaluateFormulas } from "./spreadsheet-formula.ts";
import { AssemblyRules } from "./spreadsheet-rules.ts";
import { readXlsx, writeXlsx, setNumberFormat } from "./spreadsheet-ooxml.ts";

async function read(file: SpreadsheetFile): Promise<Workbook> {
  if (file.content.byteLength > DELIVERY_LIMITS.fileBytes)
    fail("file_bytes_exceeded");
  const book =
    file.mediaType === "text/csv"
      ? readCsv(file.content)
      : file.mediaType === XLSX_MEDIA_TYPE
        ? await readXlsx(file.content)
        : fail("media_type_unsupported");
  evaluateFormulas(book);
  return book;
}
function inspect(book: Workbook): SpreadsheetInspection {
  return {
    sheets: book.sheets.map(({ name, rows, columns }) => ({
      name,
      rows,
      columns,
    })),
    formulaCount: book.formulaCount,
  };
}
function writeCell(
  sheet: Sheet,
  patch: SpreadsheetCellPatch,
  requireEmpty: boolean,
): void {
  const ref = address(patch.cell);
  for (const merge of sheet.merges)
    if (
      ref.row >= merge.first.row &&
      ref.row <= merge.last.row &&
      ref.column >= merge.first.column &&
      ref.column <= merge.last.column &&
      ref.key !== merge.first.key
    )
      fail("merged_cell_write");
  const previous = sheet.cells.get(ref.key);
  if (
    requireEmpty &&
    (previous?.formula !== undefined ||
      (previous?.value !== null &&
        previous?.value !== undefined &&
        previous?.value !== ""))
  )
    fail("target_occupied");
  const value = patch.value;
  if (typeof value === "number" && !Number.isFinite(value))
    fail("cell_invalid");
  if (
    typeof value === "string" &&
    (value.length > 32767 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value))
  )
    fail("cell_text_invalid");
  const formula =
    value !== null && typeof value === "object"
      ? value.formula.replace(/^=/u, "")
      : undefined;
  sheet.cells.set(ref.key, {
    address: ref.key,
    row: ref.row,
    column: ref.column,
    changed: true,
    value:
      formula !== undefined
        ? null
        : (value as Exclude<SpreadsheetCellPatch["value"], object>),
    ...(formula !== undefined ? { formula } : {}),
    ...(previous?.xml ? { xml: previous.xml } : {}),
  });
  dimensions(sheet, ref.row, ref.column);
  sheet.dirty = true;
}
async function verifyAndEncode(book: Workbook): Promise<{
  content: Uint8Array;
  inspection: SpreadsheetInspection;
  formulaCount: number;
}> {
  evaluateFormulas(book);
  const content = await writeXlsx(book);
  const reopened = await readXlsx(content);
  for (const sheet of book.sheets) {
    const saved = sheetNamed(reopened, sheet.name);
    for (const [key, cell] of sheet.cells) {
      const actual = saved.cells.get(key);
      if (
        (actual?.value ?? null) !== cell.value ||
        actual?.formula !== cell.formula
      )
        fail("verification_failed");
    }
  }
  evaluateFormulas(reopened);
  return {
    content,
    inspection: inspect(reopened),
    formulaCount: reopened.formulaCount,
  };
}

export class SpreadsheetEngine implements SpreadsheetEnginePort {
  async inspect(file: SpreadsheetFile): Promise<SpreadsheetInspection> {
    return inspect(await read(file));
  }
  async readPage(
    file: SpreadsheetFile,
    query: { sheet: string; startRow: number; limit: number },
  ): Promise<SpreadsheetPage> {
    if (
      !Number.isSafeInteger(query.startRow) ||
      query.startRow < 1 ||
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > DELIVERY_LIMITS.pageRows
    )
      fail("page_invalid");
    const sheet = sheetNamed(await read(file), query.sheet);
    if (query.startRow > sheet.rows + 1) fail("page_invalid");
    const rows: SpreadsheetPage["rows"][number][] = [];
    const page = (): SpreadsheetPage => ({
      sheet: sheet.name,
      startRow: query.startRow,
      rows,
      nextRow:
        query.startRow + rows.length <= sheet.rows
          ? query.startRow + rows.length
          : null,
      totalRows: sheet.rows,
      totalColumns: sheet.columns,
    });
    for (
      let row = query.startRow;
      row <= sheet.rows && rows.length < query.limit;
      row++
    ) {
      rows.push(
        Array.from({ length: sheet.columns }, (_, index) =>
          cellValue(sheet, row, index + 1),
        ),
      );
      if (
        Buffer.byteLength(JSON.stringify(page()), "utf8") >
        DELIVERY_LIMITS.pageBytes
      ) {
        rows.pop();
        if (!rows.length) fail("page_row_too_large");
        break;
      }
    }
    return page();
  }
  async patch(input: {
    file: SpreadsheetFile;
    patches: readonly SpreadsheetCellPatch[];
  }): Promise<{
    content: Uint8Array;
    inspection: SpreadsheetInspection;
    formulaCount: number;
  }> {
    const book = await read(input.file);
    if (!book.parts) fail("template_must_be_xlsx");
    if (!input.patches.length || input.patches.length > DELIVERY_LIMITS.patches)
      fail("patches_invalid");
    const seen = new Set<string>();
    for (const patch of input.patches) {
      const key = `${patch.sheet}\u0000${address(patch.cell).key}`;
      if (seen.has(key)) fail("patch_duplicate");
      seen.add(key);
      const sheet = sheetNamed(book, patch.sheet);
      writeCell(sheet, patch, false);
      if (patch.numberFormat !== undefined)
        setNumberFormat(
          book,
          sheet,
          address(patch.cell).key,
          patch.numberFormat,
        );
    }
    return verifyAndEncode(book);
  }
  async assemble(input: {
    template: SpreadsheetFile;
    sources: readonly SpreadsheetFile[];
    request: DeliveryAssembleRequest;
  }): Promise<{
    content: Uint8Array;
    inspection: SpreadsheetInspection;
    validation: DeliveryValidation;
  }> {
    const { request } = input;
    if (request.templateInputId !== input.template.inputId)
      fail("template_invalid");
    const book = await read(input.template);
    if (!book.parts) fail("template_must_be_xlsx");
    const target = sheetNamed(book, request.targetSheet);
    if (
      !Number.isSafeInteger(request.startRow) ||
      request.startRow < 1 ||
      request.startRow > DELIVERY_LIMITS.rows
    )
      fail("rows_exceeded");
    if (
      !request.sources.length ||
      request.sources.length > DELIVERY_LIMITS.inputs * 256 ||
      !request.columns.length ||
      request.columns.length > DELIVERY_LIMITS.columns
    )
      fail("mapping_invalid");
    const targetColumns = request.columns.map((column) =>
      columnNumber(column.targetColumn),
    );
    if (
      new Set(targetColumns).size !== targetColumns.length ||
      new Set(request.columns.map((c) => c.sourceHeader)).size !==
        request.columns.length
    )
      fail("mapping_invalid");
    const files = new Map(input.sources.map((file) => [file.inputId, file]));
    if (files.size !== input.sources.length) fail("source_duplicate");
    const loaded = new Map<string, Workbook>();
    const seen = new Set<string>();
    const sources: DeliveryValidation["sources"][number][] = [];
    const numericTotals: Record<string, number> = {};
    let writtenRows = 0;
    const rules = request.rules
      ? new AssemblyRules(book, request.targetSheet, request.rules, writeCell)
      : null;
    for (const selection of request.sources) {
      const key = `${selection.inputId}\u0000${selection.sheet}`;
      if (seen.has(key)) fail("source_duplicate");
      seen.add(key);
      const file = files.get(selection.inputId);
      if (!file) fail("source_missing");
      const sourceBook = loaded.get(selection.inputId) ?? (await read(file));
      loaded.set(selection.inputId, sourceBook);
      const source = sheetNamed(sourceBook, selection.sheet);
      if (
        !Number.isSafeInteger(selection.headerRow) ||
        selection.headerRow < 1 ||
        selection.headerRow > source.rows
      )
        fail("header_invalid");
      const headers = Array.from({ length: source.columns }, (_, index) =>
        cellValue(source, selection.headerRow, index + 1),
      );
      const mapping = request.columns.map((c) => {
        const indexes = headers.flatMap((header, index) =>
          header === c.sourceHeader ? [index + 1] : [],
        );
        if (indexes.length !== 1) fail("header_invalid");
        return indexes[0];
      });
      const classify = rules?.prepare(headers);
      let written = 0;
      let excludedBlankRows = 0;
      let excludedRuleRows = 0;
      let exceptionRows = 0;
      for (let row = selection.headerRow + 1; row <= source.rows; row++) {
        const values = Array.from({ length: source.columns }, (_, index) =>
          cellValue(source, row, index + 1),
        );
        const origin = {
          inputId: selection.inputId,
          sheet: selection.sheet,
          row,
        };
        const status = classify
          ? classify(origin, values)
          : values.every((value) => value === null || value === "")
            ? "excluded_blank"
            : "written";
        rules?.record(
          origin,
          status,
          target.name,
          status === "written" ? request.startRow + writtenRows : null,
        );
        if (status === "excluded_blank") {
          excludedBlankRows++;
          continue;
        }
        if (status === "excluded_rule") {
          excludedRuleRows++;
          continue;
        }
        if (status === "exception") {
          exceptionRows++;
          continue;
        }
        for (let i = 0; i < request.columns.length; i++) {
          const value = values[mapping[i] - 1];
          const column = request.columns[i].targetColumn;
          writeCell(
            target,
            {
              sheet: target.name,
              cell: `${column}${request.startRow + writtenRows}`,
              value,
            },
            true,
          );
          if (typeof value === "number") {
            numericTotals[column] = (numericTotals[column] ?? 0) + value;
            if (!Number.isFinite(numericTotals[column]))
              fail("total_non_finite");
          }
        }
        written++;
        writtenRows++;
      }
      sources.push({
        inputId: selection.inputId,
        sheet: selection.sheet,
        readRows: source.rows - selection.headerRow,
        writtenRows: written,
        excludedBlankRows,
        ...(rules ? { excludedRuleRows, exceptionRows } : {}),
      });
    }
    rules?.finish();
    const encoded = await verifyAndEncode(book);
    return {
      content: encoded.content,
      inspection: encoded.inspection,
      validation: {
        status: "verified",
        sources,
        writtenRows,
        numericTotals,
        formulaCount: encoded.formulaCount,
        warnings: [
          "Numeric column totals are arithmetic checks, not a currency-aware business aggregation.",
        ],
      },
    };
  }
}
