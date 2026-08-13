export const MAX_KNOWLEDGE_TITLE_BYTES = 256;
export const MAX_KNOWLEDGE_CONTENT_BYTES = 32 * 1024;

export type KnowledgeRecord = Readonly<{
  schemaVersion: "crewon.knowledge.v0";
  knowledgeId: string;
  tenantId: string;
  spaceId: string;
  ownerActorId: string;
  kind: "memory" | "source";
  sourceId: string;
  title: string;
  content: string;
  contentDigest: string;
  createdAt: string;
}>;

export class KnowledgeError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "KnowledgeError";
    this.code = code;
  }
}

export function parseKnowledgeRecord(input: unknown): KnowledgeRecord {
  const value = object(input, "knowledge_record_invalid");
  exactKeys(value, [
    "content",
    "contentDigest",
    "createdAt",
    "kind",
    "knowledgeId",
    "ownerActorId",
    "schemaVersion",
    "sourceId",
    "spaceId",
    "tenantId",
    "title",
  ]);
  if (value.schemaVersion !== "crewon.knowledge.v0")
    fail("knowledge_version_unsupported");
  for (const [candidate, code] of [
    [value.knowledgeId, "knowledge_id_invalid"],
    [value.tenantId, "knowledge_tenant_invalid"],
    [value.spaceId, "knowledge_space_invalid"],
    [value.ownerActorId, "knowledge_owner_invalid"],
    [value.sourceId, "knowledge_source_id_invalid"],
  ] as const)
    opaqueId(candidate, code);
  if (value.kind !== "memory" && value.kind !== "source")
    fail("knowledge_kind_invalid");
  boundedUtf8(
    value.title,
    MAX_KNOWLEDGE_TITLE_BYTES,
    "knowledge_title_invalid",
  );
  boundedUtf8(
    value.content,
    MAX_KNOWLEDGE_CONTENT_BYTES,
    "knowledge_content_invalid",
  );
  if (
    typeof value.contentDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.contentDigest)
  )
    fail("knowledge_digest_invalid");
  if (
    typeof value.createdAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.createdAt) ||
    new Date(value.createdAt).toISOString() !== value.createdAt
  )
    fail("knowledge_created_at_invalid");
  return structuredClone(value) as KnowledgeRecord;
}

function boundedUtf8(
  value: unknown,
  maximum: number,
  code: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.normalize("NFC") !== value ||
    !wellFormed(value) ||
    Buffer.byteLength(value, "utf8") > maximum
  )
    fail(code);
}

function opaqueId(value: unknown, code: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)
  )
    fail(code);
}

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (next < 0xdc00 || next > 0xdfff) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    fail(code);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0"))
    fail("knowledge_fields_invalid");
}

function fail(code: string): never {
  throw new KnowledgeError(code);
}
