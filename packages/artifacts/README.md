# @crewon/artifacts

Standalone Artifact authority for the TypeScript runtime. Metadata and write
state live in SQLite; immutable content is stored as AES-256-GCM encrypted files.
The public application port exposes Artifact IDs and verified bytes, never blob
paths.

This adapter is for a single-host deployment. Multi-host Team deployments must
use a shared object store and external KMS adapter behind the same
`ArtifactStorePort` contract.
