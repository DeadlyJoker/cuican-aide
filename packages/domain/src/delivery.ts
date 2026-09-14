export const XLSX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const;
export const DELIVERY_LIMITS = {
  fileBytes: 10 * 1024 * 1024,
  expandedBytes: 64 * 1024 * 1024,
  inputs: 20,
  versions: 100,
  rows: 100_000,
  columns: 256,
  pageRows: 100,
  pageBytes: 9 * 1024,
  patches: 1000,
} as const;

export type DeliveryTargetRef = Readonly<{
  schemaVersion: "crewon.delivery-target.v1";
  tenantId: string;
  spaceId: string;
  threadId: string;
  targetId: "thread-deliveries";
}>;
export type DeliveryResultRef = Readonly<{
  schemaVersion: "crewon.delivery-result.v1";
  target: DeliveryTargetRef;
  deliveryId: string;
  versionId: string;
  contentDigest: string;
  mediaType: typeof XLSX_MEDIA_TYPE;
  sourceRunId: string | null;
  availability: "ready";
}>;
export type SpreadsheetCellValue = string | number | boolean | null;
export type SpreadsheetCellPatch = Readonly<{
  sheet: string;
  cell: string;
  value: SpreadsheetCellValue | Readonly<{ formula: string }>;
  numberFormat?: "0" | "0.0" | "0.00";
}>;
export type SpreadsheetSheet = Readonly<{
  name: string;
  rows: number;
  columns: number;
}>;
export type SpreadsheetInspection = Readonly<{
  sheets: readonly SpreadsheetSheet[];
  formulaCount: number;
}>;
export type SpreadsheetPage = Readonly<{
  sheet: string;
  startRow: number;
  rows: readonly (readonly SpreadsheetCellValue[])[];
  nextRow: number | null;
  totalRows: number;
  totalColumns: number;
}>;
export type DeliveryInputRecord = Readonly<{
  sourceRunId?: string | null;
  inputId: string;
  target: DeliveryTargetRef;
  ownerActorId: string;
  name: string;
  role: "data" | "template";
  mediaType: "text/csv" | typeof XLSX_MEDIA_TYPE;
  byteLength: number;
  contentDigest: string;
  inspection: SpreadsheetInspection;
  createdAt: string;
}>;
export type DeliverySourceSelection = Readonly<{
  inputId: string;
  sheet: string;
  headerRow: number;
}>;
export type DeliveryColumnMapping = Readonly<{
  sourceHeader: string;
  targetColumn: string;
}>;
export type DeliveryAssemblyRules = Readonly<{
  exclude: readonly Readonly<{
    header: string;
    equals: SpreadsheetCellValue;
  }>[];
  requiredHeaders: readonly string[];
  exceptionSheet: string;
  lineageSheet: string;
  summary: Readonly<{
    sheet: string;
    startRow: number;
    groupBy: readonly string[];
    valueHeader: string;
  }>;
}>;
export type DeliveryAssembleRequest = Readonly<{
  templateInputId: string;
  name: string;
  sources: readonly DeliverySourceSelection[];
  targetSheet: string;
  startRow: number;
  columns: readonly DeliveryColumnMapping[];
  rules?: DeliveryAssemblyRules;
}>;
export type DeliveryValidation = Readonly<{
  status: "verified";
  sources: readonly Readonly<{
    inputId: string;
    sheet: string;
    readRows: number;
    writtenRows: number;
    excludedBlankRows: number;
    excludedRuleRows?: number;
    exceptionRows?: number;
  }>[];
  writtenRows: number;
  numericTotals: Readonly<Record<string, number>>;
  formulaCount: number;
  warnings: readonly string[];
}>;
export type DeliveryVersionRecord = DeliveryResultRef &
  Readonly<{
    ownerActorId: string;
    name: string;
    byteLength: number;
    createdAt: string;
    parentVersionId: string | null;
    inputIds: readonly string[];
    inspection: SpreadsheetInspection;
    validation: DeliveryValidation;
    retention: "saved";
  }>;
export type DeliveryCatalog = Readonly<{
  target: DeliveryTargetRef;
  inputs: readonly DeliveryInputRecord[];
  deliveries: readonly DeliveryVersionRecord[];
}>;
export type DeliveryPatchRequest = Readonly<{
  deliveryId: string;
  expectedVersionId: string;
  expectedContentDigest: string;
  patches: readonly SpreadsheetCellPatch[];
}>;

export class DeliveryError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "DeliveryError";
    this.code = code;
  }
}
export function deliveryObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  )
    throw new DeliveryError("delivery_fields_invalid");
  return value as Record<string, unknown>;
}
export function deliveryId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)
  )
    throw new DeliveryError("delivery_id_invalid");
  return value;
}
export function deliveryDigest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value))
    throw new DeliveryError("delivery_digest_invalid");
  return value;
}
export function parseDeliveryTargetRef(value: unknown): DeliveryTargetRef {
  const v = deliveryObject(value, [
    "schemaVersion",
    "tenantId",
    "spaceId",
    "threadId",
    "targetId",
  ]);
  if (
    v.schemaVersion !== "crewon.delivery-target.v1" ||
    v.targetId !== "thread-deliveries"
  )
    throw new DeliveryError("delivery_target_unsupported");
  return {
    schemaVersion: v.schemaVersion,
    tenantId: deliveryId(v.tenantId),
    spaceId: deliveryId(v.spaceId),
    threadId: deliveryId(v.threadId),
    targetId: v.targetId,
  };
}
export function parseDeliveryResultRef(value: unknown): DeliveryResultRef {
  const v = deliveryObject(value, [
    "schemaVersion",
    "target",
    "deliveryId",
    "versionId",
    "contentDigest",
    "mediaType",
    "sourceRunId",
    "availability",
  ]);
  if (
    v.schemaVersion !== "crewon.delivery-result.v1" ||
    v.mediaType !== XLSX_MEDIA_TYPE ||
    v.availability !== "ready"
  )
    throw new DeliveryError("delivery_result_unsupported");
  return {
    schemaVersion: v.schemaVersion,
    target: parseDeliveryTargetRef(v.target),
    deliveryId: deliveryId(v.deliveryId),
    versionId: deliveryId(v.versionId),
    contentDigest: deliveryDigest(v.contentDigest),
    mediaType: v.mediaType,
    sourceRunId: v.sourceRunId === null ? null : deliveryId(v.sourceRunId),
    availability: v.availability,
  };
}
