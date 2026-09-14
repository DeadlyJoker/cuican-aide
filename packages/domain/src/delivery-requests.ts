import {
  DELIVERY_LIMITS,
  DeliveryError,
  deliveryDigest,
  deliveryId,
  deliveryObject,
  type DeliveryAssemblyRules,
  type DeliveryAssembleRequest,
  type DeliveryPatchRequest,
  type SpreadsheetCellPatch,
} from "./delivery.ts";

export function deliveryFileName(
  value: unknown,
  extension: "csv" | "xlsx",
): string {
  if (
    typeof value !== "string" ||
    value.length > 180 ||
    !value.toLowerCase().endsWith(`.${extension}`) ||
    /[\x00-\x1f\x7f/\\]/u.test(value) ||
    value.trim() !== value
  )
    throw new DeliveryError("delivery_name_invalid");
  return value;
}
export function deliverySheetName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 31 ||
    /[\x00-\x1f\x7f\[\]:*?/\\]/u.test(value)
  )
    throw new DeliveryError("delivery_sheet_invalid");
  return value;
}
export function deliveryInteger(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max)
    throw new DeliveryError("delivery_range_invalid");
  return Number(value);
}
export function deliveryHeader(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 256 ||
    /[\x00-\x1f]/u.test(value)
  )
    throw new DeliveryError("delivery_header_invalid");
  return value;
}
function column(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Z]{1,2}$/u.test(value) ||
    [...value].reduce((sum, c) => sum * 26 + c.charCodeAt(0) - 64, 0) >
      DELIVERY_LIMITS.columns
  )
    throw new DeliveryError("delivery_column_invalid");
  return value;
}
export function parseDeliveryAssembleRequest(
  value: unknown,
): DeliveryAssembleRequest {
  const hasRules =
    value !== null && typeof value === "object" && "rules" in value;
  const v = deliveryObject(value, [
    "templateInputId",
    "name",
    "sources",
    "targetSheet",
    "startRow",
    "columns",
    ...(hasRules ? ["rules"] : []),
  ]);
  if (
    !Array.isArray(v.sources) ||
    !v.sources.length ||
    v.sources.length > 100 ||
    !Array.isArray(v.columns) ||
    !v.columns.length ||
    v.columns.length > DELIVERY_LIMITS.columns
  )
    throw new DeliveryError("delivery_mapping_invalid");
  const sources = v.sources.map((s) => {
    const x = deliveryObject(s, ["inputId", "sheet", "headerRow"]);
    return {
      inputId: deliveryId(x.inputId),
      sheet: deliverySheetName(x.sheet),
      headerRow: deliveryInteger(x.headerRow, DELIVERY_LIMITS.rows),
    };
  });
  const columns = v.columns.map((c) => {
    const x = deliveryObject(c, ["sourceHeader", "targetColumn"]);
    return {
      sourceHeader: deliveryHeader(x.sourceHeader),
      targetColumn: column(x.targetColumn),
    };
  });
  if (
    new Set(sources.map((s) => JSON.stringify(s))).size !== sources.length ||
    new Set(columns.map((c) => c.targetColumn)).size !== columns.length
  )
    throw new DeliveryError("delivery_mapping_duplicate");
  return {
    templateInputId: deliveryId(v.templateInputId),
    name: deliveryFileName(v.name, "xlsx"),
    sources,
    targetSheet: deliverySheetName(v.targetSheet),
    startRow: deliveryInteger(v.startRow, DELIVERY_LIMITS.rows),
    columns,
    ...(hasRules ? { rules: parseRules(v.rules) } : {}),
  };
}
function parseRules(value: unknown): DeliveryAssemblyRules {
  const r = deliveryObject(value, [
    "exclude",
    "requiredHeaders",
    "exceptionSheet",
    "lineageSheet",
    "summary",
  ]);
  if (
    !Array.isArray(r.exclude) ||
    r.exclude.length > 32 ||
    !Array.isArray(r.requiredHeaders) ||
    r.requiredHeaders.length > 256
  )
    throw new DeliveryError("delivery_rules_invalid");
  const exclude = r.exclude.map((entry) => {
    const e = deliveryObject(entry, ["header", "equals"]);
    if (
      (e.equals !== null &&
        typeof e.equals !== "string" &&
        typeof e.equals !== "boolean" &&
        !(typeof e.equals === "number" && Number.isFinite(e.equals))) ||
      (typeof e.equals === "string" && e.equals.length > 256)
    )
      throw new DeliveryError("delivery_rules_invalid");
    return {
      header: deliveryHeader(e.header),
      equals: e.equals as string | number | boolean | null,
    };
  });
  const s = deliveryObject(r.summary, [
    "sheet",
    "startRow",
    "groupBy",
    "valueHeader",
  ]);
  if (!Array.isArray(s.groupBy) || !s.groupBy.length || s.groupBy.length > 8)
    throw new DeliveryError("delivery_rules_invalid");
  const requiredHeaders = r.requiredHeaders.map(deliveryHeader);
  const groupBy = s.groupBy.map(deliveryHeader);
  if (
    new Set(groupBy).size !== groupBy.length ||
    new Set(requiredHeaders).size !== requiredHeaders.length
  )
    throw new DeliveryError("delivery_rules_invalid");
  return {
    exclude,
    requiredHeaders,
    exceptionSheet: deliverySheetName(r.exceptionSheet),
    lineageSheet: deliverySheetName(r.lineageSheet),
    summary: {
      sheet: deliverySheetName(s.sheet),
      startRow: deliveryInteger(s.startRow, DELIVERY_LIMITS.rows),
      groupBy,
      valueHeader: deliveryHeader(s.valueHeader),
    },
  };
}
export function parseDeliveryPatchRequest(
  value: unknown,
): DeliveryPatchRequest {
  const v = deliveryObject(value, [
    "deliveryId",
    "expectedVersionId",
    "expectedContentDigest",
    "patches",
  ]);
  if (
    !Array.isArray(v.patches) ||
    v.patches.length < 1 ||
    v.patches.length > DELIVERY_LIMITS.patches
  )
    throw new DeliveryError("delivery_patch_invalid");
  const patches = v.patches.map((p): SpreadsheetCellPatch => {
    const hasFormat =
      p !== null && typeof p === "object" && "numberFormat" in p;
    const x = deliveryObject(p, [
      "sheet",
      "cell",
      "value",
      ...(hasFormat ? ["numberFormat"] : []),
    ]);
    if (
      hasFormat &&
      x.numberFormat !== "0" &&
      x.numberFormat !== "0.0" &&
      x.numberFormat !== "0.00"
    )
      throw new DeliveryError("delivery_number_format_invalid");
    const sheet = deliverySheetName(x.sheet);
    if (typeof x.cell !== "string")
      throw new DeliveryError("delivery_cell_invalid");
    const ref = /^([A-Z]{1,2})([1-9][0-9]*)$/u.exec(x.cell);
    if (!ref) throw new DeliveryError("delivery_cell_invalid");
    column(ref[1]);
    deliveryInteger(Number(ref[2]), DELIVERY_LIMITS.rows);
    let cellValue: SpreadsheetCellPatch["value"];
    if (x.value === null || typeof x.value === "boolean") cellValue = x.value;
    else if (typeof x.value === "number" && Number.isFinite(x.value))
      cellValue = x.value;
    else if (
      typeof x.value === "string" &&
      x.value.length <= 32767 &&
      !/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(x.value)
    )
      cellValue = x.value;
    else {
      const f = deliveryObject(x.value, ["formula"]);
      if (
        typeof f.formula !== "string" ||
        f.formula.length < 1 ||
        f.formula.length > 1024
      )
        throw new DeliveryError("delivery_formula_invalid");
      cellValue = { formula: f.formula };
    }
    return {
      sheet,
      cell: x.cell,
      value: cellValue,
      ...(hasFormat
        ? { numberFormat: x.numberFormat as "0" | "0.0" | "0.00" }
        : {}),
    };
  });
  if (
    new Set(patches.map((p) => `${p.sheet}\0${p.cell}`)).size !== patches.length
  )
    throw new DeliveryError("delivery_patch_duplicate");
  return {
    deliveryId: deliveryId(v.deliveryId),
    expectedVersionId: deliveryId(v.expectedVersionId),
    expectedContentDigest: deliveryDigest(v.expectedContentDigest),
    patches,
  };
}
