# @crewon/artifacts

Standalone Artifact authority for the TypeScript runtime. Metadata and write
state live in SQLite; immutable content is stored as AES-256-GCM encrypted files.
The public application port exposes Artifact IDs and verified bytes, never blob
paths.

This adapter is for a single-host deployment. Multi-host Team deployments must
use a shared object store and external KMS adapter behind the same
`ArtifactStorePort` contract.

The local metadata schema is version 2. It adds incremental retention indexing
and permanent retirement markers; opening an older database does not scan its
artifacts or blob directories. Older binaries reject the new schema. Missing
version 2 retirement tables or triggers fail closed rather than losing deletion
proof through automatic reconstruction.

Control API owns background retention when the adapter exposes `retention`.
`CREWON_ARTIFACT_RETENTION=off` disables scheduling; the default is `on`. The
existing 30-day artifact expiry remains unchanged. The default maintenance
policy waits an additional day, then checks at most 25 records per pass, with a
1 GiB aggregate content-byte budget and a 250 ms work target checked between
operations. One slow authority query or filesystem operation may exceed that
target; it does not admit overlapping passes within the same owner.
The byte budget includes attempted deletion work whose database confirmation
could not finish; unconfirmed work cannot admit extra bodies in the same pass.

Deletion additionally requires the exact completed Tool receipt, including its
artifact reference and idempotency identity, and a terminal owning Run. Active,
unknown, unassociated, writing or corrupt artifacts remain retained. Authority
reads return at most one Run and one receipt, each capped at 1 MiB before transfer
to JavaScript. Artifact metadata reads during maintenance are capped at 16 KiB.

Retirement is sealed before unlinking immutable content. A restart can complete
an interrupted deletion, and replaying the original put returns its original
metadata without recreating the body. Metadata, idempotency records, Run events
and model history remain intact. `deletedBytes` counts confirmed retired plaintext
content sizes, not measured reclaimed filesystem blocks. Empty hash directories,
orphan temporary files and unknown recovery records are not removed by this
pass; this is not a total disk quota.

The package also exports the pure ComfyUI image-result decoder used by Control
API and Native Worker. It validates the original operation, configuration and
approved provider identity; it performs no network or storage I/O and does not
create an execution grant.
