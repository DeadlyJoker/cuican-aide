import {
  parseProjectSourceUploadPartLocator,
  type ProjectSourceUploadPartLocator,
} from "@crewon/contracts/project-source-uploads";
import {
  creativeProjectDigest,
  extensionCanonicalJson,
  validateCreativeProjectActor,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { captureProjectSourceUploadExecutionAuthority } from "./project-source-upload-plugin-commit-authority.ts";
import {
  assertSourceUploadCurrent,
  captureSourceUploadPart,
} from "./project-source-upload-validation.ts";
import type { ActorContext } from "./authorization-port.ts";
import {
  PROJECT_SOURCE_UPLOAD_PART_BYTES,
  type ProjectSourceUploadApplicationDependencies,
  type ProjectSourceUploadCommitAuthority,
  type ProjectSourceUploadExecutionAuthority,
  type ProjectSourceUploadExecutionOptions,
  type ProjectSourceUploadMutationResult,
  type ProjectSourceUploadState,
} from "./project-source-upload-port.ts";

const byteLengthGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)!.get!;

export function sourceUploadByteLength(bytes: Uint8Array): number {
  try {
    return byteLengthGetter.call(bytes) as number;
  } catch (cause) {
    throw new ApplicationError(
      "validation",
      "project_source_upload_bytes_invalid",
      { cause },
    );
  }
}

/** The trusted native adapter must return an independent snapshot before any await. */
export function captureSourceUploadBytes(
  port: ProjectSourceUploadApplicationDependencies["bytes"],
  raw: unknown,
  maximumBytes: number,
  expectedBytes: number | null,
): Uint8Array {
  try {
    const result = port.capture(raw, { maximumBytes, expectedBytes });
    const length = sourceUploadByteLength(result);
    if (
      result === raw ||
      length < 1 ||
      length > maximumBytes ||
      (expectedBytes !== null && length !== expectedBytes)
    )
      throw new Error("bad_snapshot");
    return result;
  } catch (cause) {
    throw new ApplicationError(
      "validation",
      "project_source_upload_bytes_invalid",
      { cause },
    );
  }
}

type LocatedPartDependencies = Readonly<{
  bytes: ProjectSourceUploadApplicationDependencies["bytes"];
  store: ProjectSourceUploadApplicationDependencies["store"];
  authority(
    actor: ActorContext,
    uploadId: string,
    execution?: ProjectSourceUploadExecutionAuthority,
  ): ProjectSourceUploadCommitAuthority;
  load(
    actor: ActorContext,
    uploadId: string,
    authority: ProjectSourceUploadCommitAuthority,
  ): Promise<ProjectSourceUploadState>;
  result(
    input: unknown,
    actor: ActorContext,
    uploadId: string,
  ): ProjectSourceUploadMutationResult;
  now(): string;
}>;

/** Reads the real head using write permission. No status grant or client revision is inferred. */
export async function writeLocatedProjectSourceUploadPart(
  actorInput: ActorContext,
  locatorInput: ProjectSourceUploadPartLocator,
  rawBytes: Uint8Array,
  options: ProjectSourceUploadExecutionOptions | undefined,
  dependencies: LocatedPartDependencies,
): Promise<ProjectSourceUploadMutationResult> {
  const execution = captureProjectSourceUploadExecutionAuthority(options);
  const actor = validateCreativeProjectActor(actorInput);
  const locator = parseProjectSourceUploadPartLocator(locatorInput);
  const bytes = captureSourceUploadBytes(
    dependencies.bytes,
    rawBytes,
    PROJECT_SOURCE_UPLOAD_PART_BYTES,
    null,
  );
  if (
    creativeProjectDigest(dependencies.bytes.sha256(bytes)) !==
    locator.rawDigest
  )
    throw new ApplicationError(
      "validation",
      "project_source_upload_part_digest_mismatch",
    );
  const authority = dependencies.authority(actor, locator.uploadId, execution);
  await assertSourceUploadCurrent(authority);
  const state = await dependencies.load(actor, locator.uploadId, authority);
  const part = captureSourceUploadPart(
    {
      index: locator.partIndex,
      byteOffset: locator.partIndex * PROJECT_SOURCE_UPLOAD_PART_BYTES,
      byteLength: sourceUploadByteLength(bytes),
      rawDigest: locator.rawDigest,
    },
    state.initial,
  );
  // One attempt: CAS races surface explicitly; an exact retransmission is idempotent in the Store.
  const result = dependencies.result(
    await dependencies.store.writePart(
      {
        actor,
        uploadId: locator.uploadId,
        expectedRevision: state.revision,
        part,
        bytes,
        at: dependencies.now(),
      },
      authority,
    ),
    actor,
    locator.uploadId,
  );
  const stored = result.state.parts.find((value) => value.index === part.index);
  if (
    !stored ||
    extensionCanonicalJson(stored) !== extensionCanonicalJson(part)
  )
    throw new ApplicationError(
      "internal",
      "project_source_upload_store_result_invalid",
    );
  return result;
}
