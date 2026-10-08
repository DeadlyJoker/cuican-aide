import { creativeProjectDigest, creativeProjectOpaqueId } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ProjectSourceUploadPreparedPointer } from "./project-source-upload-port.ts";

/** Internal immutable locator only. The adopting Store must qualify its actual ledger rows. */
export function captureSourceUploadPreparedPointer(
  input: unknown,
): ProjectSourceUploadPreparedPointer {
  try {
    if (
      input === null ||
      typeof input !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    )
      invalid();
    const names = [
      "version",
      "storageRealmId",
      "uploadId",
      "uploadDigest",
      "preparedDigest",
      "normalizationParserVersion",
    ];
    const descriptors = Object.getOwnPropertyDescriptors(input),
      keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== names.length ||
      keys.some((key) => typeof key !== "string" || !names.includes(key)) ||
      Object.values(descriptors).some(
        (d) => !d.enumerable || !Object.hasOwn(d, "value"),
      )
    )
      invalid();
    const v = Object.fromEntries(
      names.map((name) => [name, descriptors[name]!.value]),
    );
    if (v.version !== "crewon.project-source-upload-prepared.v1") invalid();
    return Object.freeze({
      version: "crewon.project-source-upload-prepared.v1",
      storageRealmId: creativeProjectOpaqueId(v.storageRealmId),
      uploadId: creativeProjectOpaqueId(v.uploadId),
      uploadDigest: creativeProjectDigest(v.uploadDigest),
      preparedDigest: creativeProjectDigest(v.preparedDigest),
      normalizationParserVersion: creativeProjectOpaqueId(
        v.normalizationParserVersion,
      ),
    });
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError(
      "validation",
      "project_source_upload_record_invalid",
      { cause: error },
    );
  }
}
function invalid(): never {
  throw new ApplicationError(
    "validation",
    "project_source_upload_record_invalid",
  );
}
