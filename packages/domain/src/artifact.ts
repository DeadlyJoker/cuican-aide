export type ArtifactKind = "toolOutput";
export type ArtifactSensitivity = "public" | "internal" | "workspaceSensitive";

export type ArtifactSource = Readonly<{
  kind: "toolOutput";
  runId: string;
  stepId: string;
  attemptId: string;
  callId: string;
}>;

export type ArtifactRecord = Readonly<{
  schemaVersion: "crewon.artifact.v0";
  artifactId: string;
  tenantId: string;
  spaceId: string;
  ownerActorId: string;
  kind: ArtifactKind;
  mediaType: string;
  sensitivity: ArtifactSensitivity;
  source: ArtifactSource;
  contentDigest: string;
  byteLength: number;
  retention: Readonly<{
    kind: "run";
    expiresAt: string;
  }>;
  encryption: Readonly<{
    scheme: "aes256gcm" | "externalKms";
    keyId: string;
  }>;
  scan: Readonly<{
    status: "notRequired" | "pending" | "clean" | "blocked";
    scannedAt: string | null;
    scanner: string | null;
  }>;
  createdAt: string;
}>;

const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAX_RETENTION_MS = 365 * 24 * 60 * 60 * 1_000;

export class ArtifactError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ArtifactError";
    this.code = code;
  }
}

export function createArtifactRecord(input: ArtifactRecord): ArtifactRecord {
  return parseArtifactRecord(input);
}

export function parseArtifactRecord(input: unknown): ArtifactRecord {
  const artifact = requireObject(input, "artifact_invalid");
  requireExactKeys(artifact, [
    "artifactId",
    "byteLength",
    "contentDigest",
    "createdAt",
    "encryption",
    "kind",
    "mediaType",
    "ownerActorId",
    "retention",
    "scan",
    "schemaVersion",
    "sensitivity",
    "source",
    "spaceId",
    "tenantId",
  ]);
  if (artifact.schemaVersion !== "crewon.artifact.v0") {
    throw new ArtifactError("artifact_version_unsupported");
  }
  for (const [value, code] of [
    [artifact.artifactId, "artifact_id_invalid"],
    [artifact.tenantId, "artifact_tenant_invalid"],
    [artifact.spaceId, "artifact_space_invalid"],
    [artifact.ownerActorId, "artifact_owner_invalid"],
  ] as const) {
    requireOpaqueId(value, code);
  }
  if (artifact.kind !== "toolOutput") {
    throw new ArtifactError("artifact_kind_invalid");
  }
  if (
    typeof artifact.mediaType !== "string" ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u.test(
      artifact.mediaType,
    )
  ) {
    throw new ArtifactError("artifact_media_type_invalid");
  }
  if (
    artifact.sensitivity !== "public" &&
    artifact.sensitivity !== "internal" &&
    artifact.sensitivity !== "workspaceSensitive"
  ) {
    throw new ArtifactError("artifact_sensitivity_invalid");
  }
  requireDigest(artifact.contentDigest);
  if (
    !Number.isSafeInteger(artifact.byteLength) ||
    Number(artifact.byteLength) < 1 ||
    Number(artifact.byteLength) > MAX_ARTIFACT_BYTES
  ) {
    throw new ArtifactError("artifact_byte_length_invalid");
  }
  const source = parseSource(artifact.source);
  const createdAt = requireTimestamp(
    artifact.createdAt,
    "artifact_created_at_invalid",
  );
  const retention = parseRetention(artifact.retention, createdAt);
  const encryption = parseEncryption(artifact.encryption);
  const scan = parseScan(artifact.scan);
  if (artifact.mediaType !== "text/plain" || scan.status === "pending") {
    throw new ArtifactError("artifact_tool_output_metadata_invalid");
  }
  return structuredClone({
    ...artifact,
    source,
    retention,
    encryption,
    scan,
  }) as ArtifactRecord;
}

function parseSource(value: unknown): ArtifactSource {
  const source = requireObject(value, "artifact_source_invalid");
  requireExactKeys(source, ["attemptId", "callId", "kind", "runId", "stepId"]);
  if (source.kind !== "toolOutput") {
    throw new ArtifactError("artifact_source_invalid");
  }
  for (const id of [
    source.runId,
    source.stepId,
    source.attemptId,
    source.callId,
  ]) {
    requireOpaqueId(id, "artifact_source_invalid");
  }
  return structuredClone(source) as ArtifactSource;
}

function parseRetention(
  value: unknown,
  createdAt: string,
): ArtifactRecord["retention"] {
  const retention = requireObject(value, "artifact_retention_invalid");
  requireExactKeys(retention, ["expiresAt", "kind"]);
  const expiresAt = requireTimestamp(
    retention.expiresAt,
    "artifact_retention_invalid",
  );
  const lifetime = Date.parse(expiresAt) - Date.parse(createdAt);
  if (
    retention.kind !== "run" ||
    lifetime <= 0 ||
    lifetime > MAX_RETENTION_MS
  ) {
    throw new ArtifactError("artifact_retention_invalid");
  }
  return { kind: "run", expiresAt };
}

function parseEncryption(value: unknown): ArtifactRecord["encryption"] {
  const encryption = requireObject(value, "artifact_encryption_invalid");
  requireExactKeys(encryption, ["keyId", "scheme"]);
  if (
    encryption.scheme !== "aes256gcm" &&
    encryption.scheme !== "externalKms"
  ) {
    throw new ArtifactError("artifact_encryption_invalid");
  }
  requireOpaqueId(encryption.keyId, "artifact_encryption_invalid");
  return structuredClone(encryption) as ArtifactRecord["encryption"];
}

function parseScan(value: unknown): ArtifactRecord["scan"] {
  const scan = requireObject(value, "artifact_scan_invalid");
  requireExactKeys(scan, ["scannedAt", "scanner", "status"]);
  if (
    scan.status !== "notRequired" &&
    scan.status !== "pending" &&
    scan.status !== "clean" &&
    scan.status !== "blocked"
  ) {
    throw new ArtifactError("artifact_scan_invalid");
  }
  if (scan.status === "notRequired" || scan.status === "pending") {
    if (scan.scannedAt !== null || scan.scanner !== null) {
      throw new ArtifactError("artifact_scan_invalid");
    }
  } else {
    requireTimestamp(scan.scannedAt, "artifact_scan_invalid");
    requireOpaqueId(scan.scanner, "artifact_scan_invalid");
  }
  return structuredClone(scan) as ArtifactRecord["scan"];
}

function requireObject(value: unknown, code: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new ArtifactError(code);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new ArtifactError("artifact_fields_invalid");
  }
}

function requireOpaqueId(
  value: unknown,
  code: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  ) {
    throw new ArtifactError(code);
  }
}

function requireDigest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new ArtifactError("artifact_digest_invalid");
  }
}

function requireTimestamp(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    !value.endsWith("Z") ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new ArtifactError(code);
  }
  return value;
}
