import type { ArtifactRecord } from "@crewon/domain";

export type ArtifactLocator = Readonly<{
  tenantId: string;
  artifactId: string;
}>;

export type PutArtifactInput = Readonly<{
  record: ArtifactRecord;
  content: Uint8Array;
  idempotencyKey: string;
}>;

export type PutArtifactResult = Readonly<{
  disposition: "created" | "replayed";
  record: ArtifactRecord;
}>;

export type ArtifactContent = Readonly<{
  record: ArtifactRecord;
  content: Uint8Array;
}>;

/** Persists immutable Artifact metadata and encrypted content outside Run state. */
export interface ArtifactStorePort {
  put(input: PutArtifactInput): Promise<PutArtifactResult>;
  get(locator: ArtifactLocator): Promise<ArtifactRecord | null>;
  read(locator: ArtifactLocator): Promise<ArtifactContent | null>;
  close(): Promise<void>;
}

export class ArtifactStoreError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "ArtifactStoreError";
    this.code = code;
  }
}
