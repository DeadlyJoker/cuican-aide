import { z } from "zod";

const encoder = new TextEncoder();
const reservedNames = new Set(["constructor", "prototype", "__proto__"]);
const credentialName =
  /(?:password|passwd|secret|token|cookie|credential|authorization|api[_ ]?key|密码|令牌|密钥)/iu;

/** Preserve the plain JSON-object boundary; field checking belongs to strict Zod schemas. */
export const skillObjectSchema = z.custom<Record<string, unknown>>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    [null, Object.prototype].includes(Object.getPrototypeOf(value)),
  { error: "skill_shape_invalid" },
);

function strictObject<T extends z.ZodRawShape>(shape: T) {
  // Zod's record parser intentionally skips __proto__; do not pass raw C02 objects through it.
  return skillObjectSchema
    .refine(
      (value) => ![...reservedNames].some((key) => Object.hasOwn(value, key)),
      { error: "skill_shape_invalid" },
    )
    .pipe(z.strictObject(shape, { error: "skill_shape_invalid" }));
}

export function skillAllowedKeysSchema(keys: readonly string[]) {
  return strictObject(
    Object.fromEntries(keys.map((key) => [key, z.unknown().optional()])),
  );
}

export function skillTextSchema(maxBytes: number, code = "skill_text_invalid") {
  return z
    .string({ error: code })
    .max(maxBytes, { error: code })
    .refine(
      (value) =>
        value.trim().length > 0 && encoder.encode(value).length <= maxBytes,
      { error: code },
    );
}

function texts(maxItems: number, maxBytes: number, allowEmpty = false) {
  return z
    .array(skillTextSchema(maxBytes), { error: "skill_list_invalid" })
    .min(allowEmpty ? 0 : 1, { error: "skill_list_invalid" })
    .max(maxItems, { error: "skill_list_invalid" });
}

const versionId = skillTextSchema(128, "skill_ref_invalid")
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u, { error: "skill_ref_invalid" })
  .refine((value) => value.toLowerCase() !== "latest", {
    error: "skill_ref_invalid",
  });
const digest = (code: string) =>
  z.string({ error: code }).regex(/^sha256:[a-f0-9]{64}$/u, { error: code });

export const skillVersionRefSchema = strictObject({
  skillId: versionId,
  versionId,
  contentDigest: digest("skill_digest_invalid"),
});

const parameterName = skillTextSchema(64)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/u, { error: "skill_parameter_name_invalid" })
  .refine((value) => !reservedNames.has(value) && !credentialName.test(value), {
    error: "skill_parameter_name_invalid",
  })
  .describe(
    "Non-sensitive input identifier. Credential, password, token, cookie and API-key inputs must use runtime authorization instead.",
  );

const skillParameterSchema = strictObject({
  name: parameterName,
  label: skillTextSchema(160)
    .refine((value) => !credentialName.test(value), {
      error: "skill_parameter_label_invalid",
    })
    .describe(
      "Human-readable label for a non-sensitive input; credentials must be supplied through runtime authorization.",
    ),
  type: z.enum(["string", "number", "boolean"], {
    error: "skill_parameter_type_invalid",
  }),
  required: z.boolean({ error: "skill_parameter_type_invalid" }),
  enum: texts(32, 256)
    .optional()
    .describe("Allowed values for string inputs only."),
}).refine((field) => field.enum === undefined || field.type === "string", {
  error: "skill_parameter_enum_invalid",
});

export const skillMethodSchema = strictObject({
  name: skillTextSchema(160).describe(
    "Short user-reviewed Skill name; maximum 160 UTF-8 bytes.",
  ),
  purpose: skillTextSchema(1024).describe(
    "When to use this method and its intended result.",
  ),
  steps: texts(40, 1024).describe(
    "Ordered portable method; each step is at most 1024 UTF-8 bytes.",
  ),
  parameters: z
    .array(skillParameterSchema, { error: "skill_parameters_schema_invalid" })
    .max(24, { error: "skill_parameters_schema_invalid" })
    .refine(
      (fields) =>
        new Set(fields.map((field) => field.name)).size === fields.length,
      { error: "skill_parameter_name_invalid" },
    ),
  requiredToolRefs: texts(24, 256, true).refine(
    (refs) => new Set(refs).size === refs.length,
    { error: "skill_tool_refs_invalid" },
  ),
  completionCriteria: texts(12, 512).describe(
    "Observable conditions the user must verify against actual results.",
  ),
  knownExceptions: texts(12, 512).describe(
    "Known failure cases and when to ask the user to take over.",
  ),
  runtimeRequirements: texts(12, 256, true).describe(
    "Dependencies and authorization requirements; never include credential values.",
  ),
});

/** Generation schema only: the host still enforces UTF-8, rendered-budget and authorization rules. */
export const skillMethodJsonSchema = z.toJSONSchema(skillMethodSchema, {
  target: "draft-2020-12",
});

export const skillRecordingSourceSchema = strictObject({
  recordingId: skillTextSchema(128),
  revision: z
    .number({ error: "skill_source_invalid" })
    .int({ error: "skill_source_invalid" })
    .min(1, { error: "skill_source_invalid" })
    .max(Number.MAX_SAFE_INTEGER, { error: "skill_source_invalid" }),
  contentDigest: digest("skill_source_invalid"),
  provenance: z.enum(["recording", "contract-fixture"], {
    error: "skill_source_invalid",
  }),
});

export const skillTimestampSchema = z
  .string({ error: "skill_timestamp_invalid" })
  .refine((value) => Number.isFinite(Date.parse(value)), {
    error: "skill_timestamp_invalid",
  });

export const skillVersionSchema = strictObject({
  schemaVersion: z.literal("crewon.skill-version.v1", {
    error: "skill_version_unsupported",
  }),
  ref: skillVersionRefSchema,
  method: skillMethodSchema,
  source: skillRecordingSourceSchema,
  markdown: z.string({ error: "skill_version_invalid" }),
  createdAt: skillTimestampSchema,
});

const invocationParametersSchema = skillObjectSchema
  .refine((value) => Object.keys(value).length <= 24, {
    error: "skill_parameters_invalid",
  })
  .refine(
    (value) => !Object.keys(value).some((key) => reservedNames.has(key)),
    { error: "skill_parameter_name_invalid" },
  )
  .pipe(
    z.record(
      z.string(),
      z.union(
        [
          z
            .string()
            .max(2048, { error: "skill_parameter_too_large" })
            .refine((value) => encoder.encode(value).length <= 2048, {
              error: "skill_parameter_too_large",
            }),
          z.number({ error: "skill_parameter_type_invalid" }),
          z.boolean({ error: "skill_parameter_type_invalid" }),
        ],
        { error: "skill_parameter_type_invalid" },
      ),
    ),
  );

export const skillInvocationSchema = strictObject({
  schemaVersion: z.literal("crewon.skill-invocation.v1", {
    error: "skill_invocation_version_unsupported",
  }),
  skill: skillVersionRefSchema,
  parameters: invocationParametersSchema,
  requiredToolRefs: texts(24, 256, true),
  // C03 remains the sole owner of the delivery target's shape and authorization meaning.
  deliveryTarget: z.unknown().optional(),
});

export const skillFrontmatterSchema = z.strictObject({
  name: z.string(),
  description: z.string(),
});

export function parseSkillSchema<T>(
  schema: z.ZodType<T>,
  value: unknown,
  fallback: string,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const message = result.error.issues[0]?.message;
  // Keep Zod diagnostics inside the adapter; callers receive the established domain error vocabulary.
  throw new Error(message?.startsWith("skill_") ? message : fallback);
}
