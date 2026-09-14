import {
  DELIVERY_LIMITS,
  XLSX_MEDIA_TYPE,
  deliveryDigest,
  deliveryId,
  deliveryObject,
  parseDeliveryTargetRef,
  parseDeliveryResultRef,
  type DeliveryCatalog,
  type DeliveryInputRecord,
  type DeliveryVersionRecord,
  type DeliveryTargetRef,
  type SpreadsheetInspection,
  type SpreadsheetPage,
  type DeliveryValidation,
} from "@crewon/domain/delivery";

const invalid = (): never => {
  throw new TypeError("control_client_delivery_response_invalid");
};
function text(value: unknown, max = 1024): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).length > max ||
    value.includes("\0")
  )
    invalid();
  return value as string;
}
function integer(value: unknown, max: number, min = 0): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < min ||
    Number(value) > max
  )
    invalid();
  return Number(value);
}
function array<T>(
  value: unknown,
  max: number,
  parser: (v: unknown) => T,
): readonly T[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  return (value as unknown[]).map(parser);
}
function timestamp(value: unknown): string {
  const parsed = text(value, 64);
  if (!Number.isFinite(Date.parse(parsed))) invalid();
  return parsed;
}
function target(value: unknown, threadId: string): DeliveryTargetRef {
  const parsed = parseDeliveryTargetRef(value);
  if (parsed.threadId !== threadId) invalid();
  return parsed;
}
function sameTarget(a: DeliveryTargetRef, b: DeliveryTargetRef) {
  if (
    a.threadId !== b.threadId ||
    a.spaceId !== b.spaceId ||
    a.tenantId !== b.tenantId
  )
    invalid();
}
function inspection(value: unknown): SpreadsheetInspection {
  const v = deliveryObject(value, ["sheets", "formulaCount"]);
  const sheets = array(v.sheets, 1024, (sheet) => {
    const s = deliveryObject(sheet, ["name", "rows", "columns"]);
    return {
      name: text(s.name, 128),
      rows: integer(s.rows, DELIVERY_LIMITS.rows),
      columns: integer(s.columns, DELIVERY_LIMITS.columns),
    };
  });
  if (
    !sheets.length ||
    new Set(sheets.map((s) => s.name)).size !== sheets.length
  )
    invalid();
  return {
    sheets,
    formulaCount: integer(
      v.formulaCount,
      DELIVERY_LIMITS.rows * DELIVERY_LIMITS.columns * 1024,
    ),
  };
}
export function parseDeliveryInput(
  value: unknown,
  threadId: string,
): DeliveryInputRecord {
  const optional =
    value && typeof value === "object" && "sourceRunId" in value
      ? ["sourceRunId"]
      : [];
  const v = deliveryObject(value, [
    "inputId",
    "target",
    "ownerActorId",
    "name",
    "role",
    "mediaType",
    "byteLength",
    "contentDigest",
    "inspection",
    "createdAt",
    ...optional,
  ]);
  if (
    (v.role !== "data" && v.role !== "template") ||
    (v.mediaType !== "text/csv" && v.mediaType !== XLSX_MEDIA_TYPE) ||
    (v.role === "template" && v.mediaType !== XLSX_MEDIA_TYPE)
  )
    invalid();
  return {
    ...(v.sourceRunId === undefined
      ? {}
      : {
          sourceRunId:
            v.sourceRunId === null ? null : deliveryId(v.sourceRunId),
        }),
    inputId: deliveryId(v.inputId),
    target: target(v.target, threadId),
    ownerActorId: deliveryId(v.ownerActorId),
    name: text(v.name),
    role: v.role as DeliveryInputRecord["role"],
    mediaType: v.mediaType as DeliveryInputRecord["mediaType"],
    byteLength: integer(v.byteLength, DELIVERY_LIMITS.fileBytes, 1),
    contentDigest: deliveryDigest(v.contentDigest),
    inspection: inspection(v.inspection),
    createdAt: timestamp(v.createdAt),
  };
}
function validation(value: unknown): DeliveryValidation {
  const v = deliveryObject(value, [
    "status",
    "sources",
    "writtenRows",
    "numericTotals",
    "formulaCount",
    "warnings",
  ]);
  if (
    v.status !== "verified" ||
    !v.numericTotals ||
    typeof v.numericTotals !== "object" ||
    Array.isArray(v.numericTotals)
  )
    invalid();
  const numericTotals: Record<string, number> = {};
  if (Object.keys(v.numericTotals as object).length > DELIVERY_LIMITS.columns)
    invalid();
  for (const [column, total] of Object.entries(v.numericTotals as object)) {
    if (
      !/^[A-Z]{1,3}$/u.test(column) ||
      typeof total !== "number" ||
      !Number.isFinite(total)
    )
      invalid();
    numericTotals[column] = total;
  }
  return {
    status: "verified",
    sources: array(v.sources, DELIVERY_LIMITS.inputs * 1024, (source) => {
      const optional =
        source && typeof source === "object"
          ? ["excludedRuleRows", "exceptionRows"].filter((key) => key in source)
          : [];
      const s = deliveryObject(source, [
        "inputId",
        "sheet",
        "readRows",
        "writtenRows",
        "excludedBlankRows",
        ...optional,
      ]);
      return {
        inputId: deliveryId(s.inputId),
        sheet: text(s.sheet, 128),
        readRows: integer(s.readRows, DELIVERY_LIMITS.rows),
        writtenRows: integer(s.writtenRows, DELIVERY_LIMITS.rows),
        excludedBlankRows: integer(s.excludedBlankRows, DELIVERY_LIMITS.rows),
        ...(s.excludedRuleRows === undefined
          ? {}
          : {
              excludedRuleRows: integer(
                s.excludedRuleRows,
                DELIVERY_LIMITS.rows,
              ),
            }),
        ...(s.exceptionRows === undefined
          ? {}
          : { exceptionRows: integer(s.exceptionRows, DELIVERY_LIMITS.rows) }),
      };
    }),
    writtenRows: integer(v.writtenRows, DELIVERY_LIMITS.rows),
    numericTotals,
    formulaCount: integer(
      v.formulaCount,
      DELIVERY_LIMITS.rows * DELIVERY_LIMITS.columns * 1024,
    ),
    warnings: array(v.warnings, 1000, (value) => text(value, 4096)),
  };
}
export function parseDeliveryVersion(
  value: unknown,
  threadId: string,
): DeliveryVersionRecord {
  const v = deliveryObject(value, [
    "schemaVersion",
    "target",
    "deliveryId",
    "versionId",
    "contentDigest",
    "mediaType",
    "sourceRunId",
    "availability",
    "ownerActorId",
    "name",
    "byteLength",
    "createdAt",
    "parentVersionId",
    "inputIds",
    "inspection",
    "validation",
    "retention",
  ]);
  const ref = parseDeliveryResultRef(
    Object.fromEntries(
      [
        "schemaVersion",
        "target",
        "deliveryId",
        "versionId",
        "contentDigest",
        "mediaType",
        "sourceRunId",
        "availability",
      ].map((key) => [key, v[key]]),
    ),
  );
  target(ref.target, threadId);
  if (v.retention !== "saved") invalid();
  return {
    ...ref,
    ownerActorId: deliveryId(v.ownerActorId),
    name: text(v.name),
    byteLength: integer(v.byteLength, DELIVERY_LIMITS.fileBytes, 1),
    createdAt: timestamp(v.createdAt),
    parentVersionId:
      v.parentVersionId === null ? null : deliveryId(v.parentVersionId),
    inputIds: array(v.inputIds, DELIVERY_LIMITS.inputs, deliveryId),
    inspection: inspection(v.inspection),
    validation: validation(v.validation),
    retention: "saved",
  };
}
export function parseDeliveryCatalog(
  value: unknown,
  threadId: string,
): DeliveryCatalog {
  const v = deliveryObject(value, ["target", "inputs", "deliveries"]);
  const result = {
    target: target(v.target, threadId),
    inputs: array(v.inputs, DELIVERY_LIMITS.inputs, (item) =>
      parseDeliveryInput(item, threadId),
    ),
    deliveries: array(v.deliveries, DELIVERY_LIMITS.versions, (item) =>
      parseDeliveryVersion(item, threadId),
    ),
  };
  for (const record of [...result.inputs, ...result.deliveries])
    sameTarget(result.target, record.target);
  if (
    new Set(result.inputs.map((v) => v.inputId)).size !==
      result.inputs.length ||
    new Set(result.deliveries.map((v) => v.deliveryId)).size !==
      result.deliveries.length
  )
    invalid();
  return result;
}
export function parseSpreadsheetPage(
  value: unknown,
  expected: { sheet: string; startRow: number; limit: number },
): SpreadsheetPage {
  const v = deliveryObject(value, [
    "sheet",
    "startRow",
    "rows",
    "nextRow",
    "totalRows",
    "totalColumns",
  ]);
  const totalRows = integer(v.totalRows, DELIVERY_LIMITS.rows);
  const totalColumns = integer(v.totalColumns, DELIVERY_LIMITS.columns);
  const rows = array(
    v.rows,
    Math.min(expected.limit, DELIVERY_LIMITS.pageRows),
    (row) =>
      array(row, totalColumns, (cell) => {
        if (
          cell === null ||
          typeof cell === "boolean" ||
          (typeof cell === "number" && Number.isFinite(cell))
        )
          return cell;
        if (
          typeof cell === "string" &&
          new TextEncoder().encode(cell).length <= DELIVERY_LIMITS.pageBytes
        )
          return cell;
        return invalid();
      }),
  );
  const startRow = integer(v.startRow, DELIVERY_LIMITS.rows + 1, 1);
  const nextRow = v.nextRow === null ? null : integer(v.nextRow, totalRows, 1);
  if (
    v.sheet !== expected.sheet ||
    startRow !== expected.startRow ||
    (rows.length > 0 && startRow + rows.length - 1 > totalRows) ||
    (nextRow !== null &&
      (rows.length === 0 || nextRow !== startRow + rows.length))
  )
    invalid();
  return {
    sheet: text(v.sheet, 128),
    startRow,
    rows,
    nextRow,
    totalRows,
    totalColumns,
  };
}
export function parseDeliveryHistory(
  value: unknown,
  threadId: string,
  deliveryId: string,
): readonly DeliveryVersionRecord[] {
  const versions = array(value, DELIVERY_LIMITS.versions, (item) =>
    parseDeliveryVersion(item, threadId),
  );
  if (
    versions.some((v) => v.deliveryId !== deliveryId) ||
    new Set(versions.map((v) => v.versionId)).size !== versions.length
  )
    invalid();
  return versions;
}
