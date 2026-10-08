import type {
  InstalledPluginPackage,
  PluginSelection,
  PluginTaskAdmissionPin,
  ProjectSourceFormat,
} from "@crewon/domain";
import type {
  ActorContext,
  AuthorizationDecision,
} from "./authorization-port.ts";
import type {
  ApplicationClock,
  ContentDigester,
} from "./application-runtime-ports.ts";
import type {
  CreativeProjectMutationReceipt,
  CreativeProjectOwnerScope,
} from "./creative-project-store-port.ts";
import type { PreparedProjectSource } from "./project-source-preparation-port.ts";

export const PROJECT_SOURCE_UPLOAD_PART_BYTES = 65_536;
export const PROJECT_SOURCE_UPLOAD_MAX_BYTES = 20_000_000;
export const PROJECT_SOURCE_UPLOAD_MAX_PARTS = 306;
export type ProjectSourceUploadPhase =
  | "receiving"
  | "raw-sealed"
  | "preparing"
  | "ready"
  | "rejected"
  | "cancelled"
  | "expired";
export type ProjectSourceUploadAction =
  | "projectSourceUpload:begin"
  | "projectSourceUpload:write"
  | "projectSourceUpload:status"
  | "projectSourceUpload:prepare"
  | "projectSourceUpload:cancel"
  | "projectSourceUpload:adopt";
export type ProjectSourceUploadPermission = Readonly<{
  actor: ActorContext;
  action: ProjectSourceUploadAction;
  resource: Readonly<{
    kind: "projectSourceUpload";
    owner: CreativeProjectOwnerScope;
    uploadId: string | null;
    projectId: string | null;
  }>;
}>;
/** Current host PDP and synchronous withdrawal; ownership or UI DTOs are not a grant. */
export interface ProjectSourceUploadAuthorizationPort {
  authorize(
    permission: ProjectSourceUploadPermission,
  ): Promise<AuthorizationDecision>;
  assertActive(permission: ProjectSourceUploadPermission): void;
}
export type ProjectSourceUploadCommitAuthority = Readonly<{
  version: "crewon.project-source-upload-commit.v1";
  permission: ProjectSourceUploadPermission;
  /** External host policy only; must not borrow the committing Store's connection or pool. */
  assertCurrent(): Promise<void>;
  assertActive(): void;
  transaction?: ProjectSourceUploadPluginCommitTransactionAuthority;
}>;
/** Independent installation commit protocol; neither a creative-project grant nor ownership qualifies it. */
export type ProjectSourceUploadPluginCommitTransactionAuthority = Readonly<{
  version: "crewon.project-source-upload-plugin-commit.v1";
  pin: PluginTaskAdmissionPin;
  selection: PluginSelection;
  package: InstalledPluginPackage;
  /** External live policy only, without borrowing the committing Store's connection. */
  assertCurrent(): Promise<void>;
}>;
/** Private invocation callbacks supplied by a genuine host lifecycle, separate from business PDP. */
export type ProjectSourceUploadExecutionAuthority = Readonly<{
  assertCurrent(): Promise<void>;
  assertActive(): void;
  transaction?: ProjectSourceUploadPluginCommitTransactionAuthority;
}>;
export type ProjectSourceUploadExecutionOptions = Readonly<{
  authority?: ProjectSourceUploadExecutionAuthority;
}>;
export type ProjectSourceUploadInitial = Readonly<{
  schemaVersion: "crewon.project-source-upload.v1";
  storageRealmId: string;
  uploadId: string;
  owner: CreativeProjectOwnerScope;
  fileName: string;
  format: ProjectSourceFormat;
  byteLength: number;
  fileDigest: string;
  partBytes: 65_536;
  partCount: number;
  requestDigest: string;
  createdByActorId: string;
  createdAt: string;
}>;
export type ProjectSourceUploadPart = Readonly<{
  index: number;
  byteOffset: number;
  byteLength: number;
  rawDigest: string;
}>;
export type ProjectSourceUploadSealed = Readonly<{
  uploadDigest: string;
  sealedAt: string;
}>;
export type ProjectSourceUploadPreparationClaim = Readonly<{
  claimId: string;
  normalizationParserVersion: string;
  expiresAt: string;
}>;
export type ProjectSourceUploadPreparedPointer = Readonly<{
  version: "crewon.project-source-upload-prepared.v1";
  storageRealmId: string;
  uploadId: string;
  uploadDigest: string;
  preparedDigest: string;
  normalizationParserVersion: string;
}>;
export type ProjectSourceUploadPreparedManifest = Readonly<{
  pointer: ProjectSourceUploadPreparedPointer;
  digest: string;
  normalizedByteLength: number;
  characterLength: number;
  chunkCount: number;
  chapterCount: number;
  chunkManifestDigest: string;
  chapterManifestDigest: string;
  preparedAt: string;
}>;
/** Immutable initial/parts/manifests; only head revision/phase/claim evolves by CAS. No consumed flag. */
export type ProjectSourceUploadState = Readonly<{
  initial: ProjectSourceUploadInitial;
  revision: number;
  phase: ProjectSourceUploadPhase;
  updatedAt: string;
  parts: readonly ProjectSourceUploadPart[];
  sealed: ProjectSourceUploadSealed | null;
  claim: ProjectSourceUploadPreparationClaim | null;
  prepared: ProjectSourceUploadPreparedManifest | null;
  failureCode: string | null;
}>;
export type ProjectSourceUploadMutationResult = Readonly<{
  disposition: "committed" | "replayed";
  state: ProjectSourceUploadState;
}>;
export type ProjectSourceUploadParsedFile = Omit<
  PreparedProjectSource,
  "uploadId" | "owner" | "provenance"
>;
export type ProjectSourceUploadPreparedSource = PreparedProjectSource &
  Readonly<{ provenance: ProjectSourceUploadPreparedPointer }>;
/** Native byte ownership and actual raw SHA-256 belong to a trusted host adapter, not JSON. */
export interface ProjectSourceUploadBytePort {
  capture(
    input: unknown,
    options: Readonly<{ maximumBytes: number; expectedBytes: number | null }>,
  ): Uint8Array;
  sha256(bytes: Uint8Array): string;
}
/** Adapter calls the actual existing media-runtime parser; no SQL/network/model operation here. */
export interface ProjectSourceUploadParserPort {
  readonly normalizationParserVersion: string;
  parse(
    input: Readonly<{
      fileName: string;
      format: ProjectSourceFormat;
      bytes: Uint8Array;
    }>,
  ): Promise<ProjectSourceUploadParsedFile>;
}
export type ProjectSourceUploadRead = Readonly<{
  owner: CreativeProjectOwnerScope;
  uploadId: string;
}>;
type Mutation = Readonly<{
  actor: ActorContext;
  uploadId: string;
  expectedRevision: number;
  at: string;
}>;
type BeginIdentity = Readonly<{
  actor: ActorContext;
  receipt: CreativeProjectMutationReceipt;
}>;
/** Parent-owned database/realm, explicit migration. No nested pool borrow during foundation association. */
export interface ProjectSourceUploadStore {
  readonly storageRealmId: string;
  loadBeginReceipt(
    input: BeginIdentity,
    authority: ProjectSourceUploadCommitAuthority,
  ): Promise<ProjectSourceUploadMutationResult | null>;
  begin(
    input: BeginIdentity & Readonly<{ initial: ProjectSourceUploadInitial }>,
    authority: ProjectSourceUploadCommitAuthority,
  ): Promise<ProjectSourceUploadMutationResult>;
  load(
    input: ProjectSourceUploadRead,
    authority: ProjectSourceUploadCommitAuthority,
  ): Promise<ProjectSourceUploadState | null>;
  /** Existing identical part replays before CAS; changed bytes at that index always conflict. */
  writePart(
    input: Mutation &
      Readonly<{ part: ProjectSourceUploadPart; bytes: Uint8Array }>,
    authority: ProjectSourceUploadCommitAuthority,
  ): Promise<ProjectSourceUploadMutationResult>;
  /** Read immutable raw snapshot and hash outside the write SQL transaction, then CAS exact
   * head/descriptor root/count and persist the sealed manifest. Never borrow again inside a transaction. */
  sealRaw(
    input: Mutation,
    authority: ProjectSourceUploadCommitAuthority,
  ): Promise<ProjectSourceUploadMutationResult>;
  /** Ready or a live claim returns existing. Only raw-sealed/expired claim CAS may claim parsing. */
  claimPreparation(
    input: Mutation & Readonly<{ claim: ProjectSourceUploadPreparationClaim }>,
    authority: ProjectSourceUploadCommitAuthority,
  ): Promise<
    Readonly<{
      disposition: "claimed" | "existing";
      state: ProjectSourceUploadState;
    }>
  >;
  /** Outside SQL mutation: rechecks exact sealed/claim pointer, yields owned actual bytes, at most 20 MB. */
  loadRawBytes(
    input: ProjectSourceUploadRead &
      Readonly<{ uploadDigest: string; claimId: string }>,
    authority: ProjectSourceUploadCommitAuthority,
  ): Promise<Uint8Array>;
  /** Verifies parsed original-byte binding, normalized chunks/chapters; derives immutable prepared digests. */
  completePreparation(
    input: Mutation &
      Readonly<{ claimId: string; parsed: ProjectSourceUploadParsedFile }>,
    authority: ProjectSourceUploadCommitAuthority,
  ): Promise<ProjectSourceUploadMutationResult>;
  rejectPreparation(
    input: Mutation & Readonly<{ claimId: string; failureCode: string }>,
    authority: ProjectSourceUploadCommitAuthority,
  ): Promise<ProjectSourceUploadMutationResult>;
  /** Only unfinished uploads. Ready/associated data are never deleted or marked consumed here. */
  cancel(
    input: Mutation,
    authority: ProjectSourceUploadCommitAuthority,
  ): Promise<ProjectSourceUploadMutationResult>;
  loadPrepared(
    input: ProjectSourceUploadRead & Readonly<{ fileDigest: string }>,
    authority: ProjectSourceUploadCommitAuthority,
  ): Promise<ProjectSourceUploadPreparedSource | null>;
}
export type ProjectSourceUploadApplicationDependencies = Readonly<{
  store: ProjectSourceUploadStore;
  authorization: ProjectSourceUploadAuthorizationPort;
  bytes: ProjectSourceUploadBytePort;
  parser: ProjectSourceUploadParserPort;
  clock: ApplicationClock;
  digester: ContentDigester;
  ids: Readonly<{ nextUploadId(): string; nextClaimId(): string }>;
  preparationClaimTtlMs: number;
}>;
