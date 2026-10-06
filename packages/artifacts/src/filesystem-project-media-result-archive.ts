import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import {
  parseFrozenProjectMediaResult,
  parseProjectMediaResultRequest,
  projectMediaResultArchiveIdentity,
  frozenProjectMediaResultFingerprint,
  type ProjectMediaResultArchivePort,
  type ProjectMediaResultRequest,
  type FrozenProjectMediaResult,
  type FrozenProjectMediaResultContent,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  projectAssetId,
  projectAssetInputFields,
} from "@crewon/domain";
const DATA_MAGIC = Buffer.from("CRWPRV01"),
  INTENT_MAGIC = Buffer.from("CRWPRI01"),
  HEADER = 36,
  MAX_METADATA = 32768,
  MAX_CONTENT = 16 * 1024 * 1024,
  MAX_FILE = HEADER + 4 + MAX_METADATA + MAX_CONTENT;

/** Immutable encrypted actual result bytes; no project adoption or task dispatch.
 * Persist the first observed record before data publication. Loss of published bytes is never a fresh request.
 */
export class FilesystemProjectMediaResultArchive
  implements ProjectMediaResultArchivePort
{
  readonly archiveId: string;
  readonly #root: string;
  readonly #rootIdentity: Readonly<{ dev: number; ino: number }>;
  readonly #key: Buffer;
  readonly #keyId: string;
  #closed = false;
  constructor(
    config: Readonly<{
      archiveId: string;
      rootDirectory: string;
      encryptionKey: Uint8Array;
      keyId: string;
    }>,
  ) {
    this.archiveId = projectAssetId(config.archiveId);
    this.#keyId = projectAssetId(config.keyId);
    if (
      typeof config.rootDirectory !== "string" ||
      !path.isAbsolute(config.rootDirectory) ||
      path.dirname(config.rootDirectory) === config.rootDirectory ||
      !(config.encryptionKey instanceof Uint8Array) ||
      config.encryptionKey.byteLength !== 32
    )
      fail("configuration_invalid");
    const initial = lstatSync(config.rootDirectory, { throwIfNoEntry: false });
    if (initial && (!initial.isDirectory() || initial.isSymbolicLink()))
      fail("path_invalid");
    mkdirSync(config.rootDirectory, { recursive: true, mode: 0o700 });
    this.#root = realpathSync(config.rootDirectory);
    chmodSync(this.#root, 0o700);
    const root = lstatSync(this.#root);
    this.#rootIdentity = Object.freeze({ dev: root.dev, ino: root.ino });
    this.#key = Buffer.from(config.encryptionKey);
    Object.defineProperty(this, "archiveId", {
      value: this.archiveId,
      writable: false,
      configurable: false,
    });
  }
  async load(
    requestInput: ProjectMediaResultRequest,
  ): Promise<FrozenProjectMediaResultContent | null> {
    this.#active();
    const request = parseProjectMediaResultRequest(requestInput),
      record = this.#intent(request);
    if (!record) {
      if (
        lstatSync(
          this.#filename(
            projectMediaResultArchiveIdentity(request, this.archiveId)
              .materialId,
            "data",
          ),
          { throwIfNoEntry: false },
        )
      )
        fail("intent_missing");
      return null;
    }
    return this.#content(record);
  }
  async save(input: FrozenProjectMediaResultContent) {
    this.#active();
    const fields = projectAssetInputFields(input, ["record", "bytes"]),
      proposed = parseFrozenProjectMediaResult(fields.record);
    if (proposed.archiveId !== this.archiveId) fail("identity_invalid");
    if (
      !(fields.bytes instanceof Uint8Array) ||
      fields.bytes.byteLength !== proposed.source.byteLength
    )
      fail("bytes_invalid");
    const bytes = Buffer.from(fields.bytes);
    validateBytes(proposed.source, bytes);
    let record = this.#intent(proposed.request);
    if (!record) {
      if (
        lstatSync(this.#filename(proposed.materialId, "data"), {
          throwIfNoEntry: false,
        })
      )
        fail("intent_missing");
      this.#publish(proposed, "intent", this.#seal(proposed, "intent"));
      record = this.#intent(proposed.request);
      if (!record) fail("intent_unverified");
    }
    assertSame(record, proposed);
    const filename = this.#filename(record.materialId, "data");
    if (lstatSync(filename, { throwIfNoEntry: false })) {
      const actual = this.#content(record);
      assertSame(actual.record, proposed);
      return Object.freeze({
        disposition: "replayed" as const,
        record: actual.record,
      });
    }
    // Recovery can only finish the same pinned intent with the exact original bytes. No network reads here.
    const created = this.#publish(
        record,
        "data",
        this.#seal(record, "data", bytes),
      ),
      actual = this.#content(record);
    assertSame(actual.record, proposed);
    return Object.freeze({
      disposition: created ? ("created" as const) : ("replayed" as const),
      record: actual.record,
    });
  }
  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#key.fill(0);
    }
  }
  #intent(request: ProjectMediaResultRequest): FrozenProjectMediaResult | null {
    const identity = projectMediaResultArchiveIdentity(request, this.archiveId),
      payload = this.#open(identity.materialId, "intent");
    if (!payload) return null;
    const decoded = this.#decode(payload);
    if (decoded.bytes.length !== 0) fail("intent_invalid");
    const record = decoded.record;
    if (
      record.archiveId !== this.archiveId ||
      record.materialId !== identity.materialId
    )
      fail("identity_invalid");
    if (record.requestDigest !== identity.requestDigest)
      fail("idempotency_conflict");
    return record;
  }
  #content(record: FrozenProjectMediaResult): FrozenProjectMediaResultContent {
    const payload = this.#open(record.materialId, "data");
    if (!payload) fail("content_missing");
    const decoded = this.#decode(payload);
    if (
      extensionCanonicalJson(decoded.record) !== extensionCanonicalJson(record)
    )
      fail("identity_invalid");
    validateBytes(record.source, decoded.bytes);
    this.#active();
    return Object.freeze({ record, bytes: decoded.bytes });
  }
  #decode(payload: Buffer): FrozenProjectMediaResultContent {
    try {
      const length = payload.readUInt32BE(0);
      if (length < 1 || length > MAX_METADATA || 4 + length > payload.length)
        fail("file_invalid");
      const record = parseFrozenProjectMediaResult(
        JSON.parse(payload.toString("utf8", 4, 4 + length)),
      );
      return Object.freeze({
        record,
        bytes: Buffer.from(payload.subarray(4 + length)),
      });
    } catch (error) {
      if (error instanceof ProjectMediaResultArchiveError) throw error;
      throw new ProjectMediaResultArchiveError(
        "project_media_result_archive_record_invalid",
        { cause: error },
      );
    }
  }
  #seal(
    record: FrozenProjectMediaResult,
    kind: "intent" | "data",
    bytes: Uint8Array = new Uint8Array(),
  ): Buffer {
    const metadata = Buffer.from(extensionCanonicalJson(record));
    if (metadata.length > MAX_METADATA) fail("metadata_limit");
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(metadata.length);
    const plain = Buffer.concat([prefix, metadata, bytes]);
    const iv = randomBytes(12),
      encrypt = createCipheriv("aes-256-gcm", this.#key, iv);
    encrypt.setAAD(this.#aad(record.materialId, kind));
    const payload = Buffer.concat([encrypt.update(plain), encrypt.final()]);
    return Buffer.concat([
      kind === "intent" ? INTENT_MAGIC : DATA_MAGIC,
      iv,
      encrypt.getAuthTag(),
      payload,
    ]);
  }
  #open(materialId: string, kind: "intent" | "data"): Buffer | null {
    this.#active();
    const filename = this.#filename(materialId, kind),
      initial = lstatSync(filename, { throwIfNoEntry: false });
    if (!initial) return null;
    const max = kind === "intent" ? HEADER + 4 + MAX_METADATA : MAX_FILE;
    if (
      !initial.isFile() ||
      initial.isSymbolicLink() ||
      initial.size < HEADER + 4 ||
      initial.size > max ||
      (initial.mode & 0o077) !== 0
    )
      fail("file_invalid");
    const fd = openSync(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let encrypted: Buffer;
    try {
      const before = fstatSync(fd);
      if (
        !before.isFile() ||
        before.ino !== initial.ino ||
        before.dev !== initial.dev ||
        before.size !== initial.size
      )
        fail("file_invalid");
      encrypted = Buffer.allocUnsafe(before.size);
      let offset = 0;
      while (offset < encrypted.length) {
        const n = readSync(
          fd,
          encrypted,
          offset,
          encrypted.length - offset,
          offset,
        );
        if (!n) fail("file_invalid");
        offset += n;
      }
      const after = fstatSync(fd);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
        fail("file_invalid");
    } finally {
      closeSync(fd);
    }
    try {
      if (
        !encrypted
          .subarray(0, 8)
          .equals(kind === "intent" ? INTENT_MAGIC : DATA_MAGIC)
      )
        fail("ciphertext_invalid");
      const decrypt = createDecipheriv(
        "aes-256-gcm",
        this.#key,
        encrypted.subarray(8, 20),
      );
      decrypt.setAAD(this.#aad(materialId, kind));
      decrypt.setAuthTag(encrypted.subarray(20, HEADER));
      const payload = Buffer.concat([
        decrypt.update(encrypted.subarray(HEADER)),
        decrypt.final(),
      ]);
      this.#active();
      return payload;
    } catch (error) {
      if (error instanceof ProjectMediaResultArchiveError) throw error;
      throw new ProjectMediaResultArchiveError(
        "project_media_result_archive_ciphertext_invalid",
        { cause: error },
      );
    }
  }
  #publish(
    record: FrozenProjectMediaResult,
    kind: "intent" | "data",
    file: Uint8Array,
  ): boolean {
    this.#active();
    const filename = this.#filename(record.materialId, kind),
      staging = `${filename}.staging-${randomBytes(16).toString("hex")}`;
    const fd = openSync(
      staging,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    let created = false;
    try {
      try {
        let offset = 0;
        while (offset < file.length) {
          const n = writeSync(fd, file, offset, file.length - offset, offset);
          if (!n) fail("write_stalled");
          offset += n;
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      this.#active();
      try {
        linkSync(staging, filename);
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      unlinkSync(staging);
      syncDirectory(this.#root);
    }
    return created;
  }
  #filename(materialId: string, kind: "intent" | "data"): string {
    if (!/^pr-[a-f0-9]{64}$/u.test(materialId)) fail("identity_invalid");
    return path.join(
      this.#root,
      `${materialId}.${kind === "intent" ? "intent-crwpr" : "crwpr"}`,
    );
  }
  #aad(materialId: string, kind: "intent" | "data"): Buffer {
    return Buffer.from(
      extensionCanonicalJson({
        archiveId: this.archiveId,
        materialId,
        keyId: this.#keyId,
        kind,
      }),
    );
  }
  #active(): void {
    if (this.#closed) fail("closed");
    const info = lstatSync(this.#root);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      info.dev !== this.#rootIdentity.dev ||
      info.ino !== this.#rootIdentity.ino ||
      realpathSync(this.#root) !== this.#root
    )
      fail("path_invalid");
  }
}
export class ProjectMediaResultArchiveError extends Error {
  readonly code: string;
  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "ProjectMediaResultArchiveError";
    this.code = code;
  }
}
function validateBytes(
  source: FrozenProjectMediaResultContent["record"]["source"],
  bytes: Uint8Array,
): void {
  if (
    bytes.length !== source.byteLength ||
    bytes.length > MAX_CONTENT ||
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
      source.byteDigest
  )
    fail("bytes_invalid");
}
function assertSame(
  actual: FrozenProjectMediaResult,
  expected: FrozenProjectMediaResult,
): void {
  if (
    frozenProjectMediaResultFingerprint(actual) !==
    frozenProjectMediaResultFingerprint(expected)
  )
    fail("idempotency_conflict");
}
function syncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function fail(code: string): never {
  throw new ProjectMediaResultArchiveError(
    `project_media_result_archive_${code}`,
  );
}
