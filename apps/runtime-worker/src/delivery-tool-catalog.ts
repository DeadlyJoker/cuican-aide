import type { ToolDefinition, ToolJsonValue } from "@crewon/tool-broker";

export const DELIVERY_MODEL_OUTPUT_BYTES = 9 * 1024;

const string = { type: "string" } as const;
const integer = { type: "integer", minimum: 1 } as const;
const object = (
  properties: Record<string, ToolJsonValue>,
  optional: readonly string[] = [],
) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
});

/** Credential-free definitions shared by release compilation and live execution. */
export function deliveryToolDefinitions(): readonly ToolDefinition[] {
  return [
    definition(
      "delivery_catalog",
      "List actual saved spreadsheet inputs or delivery versions in the current task. Follow nextOffset to read every entry; no file is inferred from conversation text.",
      object({
        kind: { type: "string", enum: ["inputs", "deliveries"] },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      }),
    ),
    definition(
      "delivery_read",
      "Read a bounded page from any sheet of a saved input or exact delivery version. Rows are one-based. Follow nextRow until null; pagination never limits assembly processing.",
      object({
        kind: { type: "string", enum: ["input", "version"] },
        id: string,
        sheet: string,
        startRow: integer,
        limit: { type: "integer", minimum: 1, maximum: 100 },
      }),
    ),
    definition(
      "delivery_assemble",
      "Create and save a verified XLSX by mapping all rows of selected CSV/XLSX sheets into an uploaded XLSX template. Optional rules explicitly exclude matching rows, route missing/invalid values to exceptions, preserve lineage, and aggregate a numeric value by chosen headers into a summary sheet. Requires approval. Unsupported workbook features fail explicitly. Returns an immutable reference only after bytes are saved; use delivery_read to inspect result and summary sheets.",
      object(
        {
          templateInputId: string,
          name: string,
          sources: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: object({
              inputId: string,
              sheet: string,
              headerRow: integer,
            }),
          },
          targetSheet: string,
          startRow: integer,
          columns: {
            type: "array",
            minItems: 1,
            maxItems: 256,
            items: object({ sourceHeader: string, targetColumn: string }),
          },
          rules: object({
            exclude: {
              type: "array",
              maxItems: 32,
              items: object({
                header: string,
                equals: { type: ["string", "number", "boolean", "null"] },
              }),
            },
            requiredHeaders: { type: "array", maxItems: 256, items: string },
            exceptionSheet: string,
            lineageSheet: string,
            summary: object({
              sheet: string,
              startRow: integer,
              groupBy: {
                type: "array",
                minItems: 1,
                maxItems: 8,
                items: string,
              },
              valueHeader: string,
            }),
          }),
        },
        ["rules"],
      ),
    ),
    definition(
      "delivery_patch",
      "Save targeted cell edits as a new XLSX version. Requires approval and the exact expected head version and digest; stale edits fail without overwriting user changes. Formula values use {formula: 'SUM(A1:A7)'}. Optional numberFormat is 0, 0.0, or 0.00. Unedited cells and previous versions are preserved.",
      object({
        deliveryId: string,
        expectedVersionId: string,
        expectedContentDigest: string,
        patches: {
          type: "array",
          minItems: 1,
          maxItems: 1000,
          items: object(
            {
              sheet: string,
              cell: string,
              value: {
                anyOf: [
                  { type: "string" },
                  { type: "number" },
                  { type: "boolean" },
                  { type: "null" },
                  object({ formula: string }),
                ],
              },
              numberFormat: { type: "string", enum: ["0", "0.0", "0.00"] },
            },
            ["numberFormat"],
          ),
        },
      }),
    ),
  ];
}

function definition(
  name: string,
  description: string,
  inputSchema: Record<string, ToolJsonValue>,
): ToolDefinition {
  return {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name,
    description,
    execution: "serial",
    inputSchema,
  };
}

/** Local hosted file storage is available only alongside fully configured artifacts. */
export function configuredDeliveryToolCatalog(
  environment: Readonly<Record<string, string | undefined>>,
): "enabled" | "disabled" {
  if (
    environment.CREWON_CONTROL_SECURITY_MODE === "production" ||
    environment.CREWON_CONTROL_DATABASE_URL?.trim()
  )
    return "disabled";
  return [
    "CREWON_ARTIFACT_ROOT",
    "CREWON_ARTIFACT_DB_PATH",
    "CREWON_ARTIFACT_ENCRYPTION_KEY_PATH",
    "CREWON_ARTIFACT_ENCRYPTION_KEY_ID",
  ].every((key) => Boolean(environment[key]?.trim()))
    ? "enabled"
    : "disabled";
}
