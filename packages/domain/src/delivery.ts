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
