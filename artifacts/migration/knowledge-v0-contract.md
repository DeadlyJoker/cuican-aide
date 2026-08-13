# Knowledge v0 production contract

Knowledge v0 is a new TypeScript-only authority. It does not import or accept legacy files and it
does not define embeddings, retrieval ranking, background ingestion, or scheduling.

## Canonical record

`crewon.knowledge.v0` stores one immutable UTF-8 text record scoped by `(tenantId, spaceId)`:

- `knowledgeId`, `tenantId`, `spaceId`, `ownerActorId`, and `sourceId` are bounded opaque IDs.
  `sourceId` is required for both kinds: for `memory` it identifies the producer/capture event; for
  `source` it identifies the originating source. Absence is rejected rather than inferred.
- `kind` is `memory` or `source`; `title` is 1..256 UTF-8 bytes and `content` is 1..32768 UTF-8
  bytes. Lone UTF-16 surrogates and non-NFC strings are rejected.
- `contentDigest` is the lowercase `sha256:<64 hex>` digest of the UTF-8 content.
- `createdAt` is canonical UTC RFC 3339 with millisecond precision.
- Unknown fields are rejected at every public boundary. Stored and replayed JSON must parse back to
  the same exact canonical record.

## Authority and mutation

Create requires `knowledge:create` authorization for the actor's exact tenant and space. Read and
list require `knowledge:read`. Callers cannot inject tenant, space, owner, digest, or timestamp.

Create is receipt-first. `(tenantId, spaceId, idempotency scope, idempotency key)` identifies the
durable receipt independently of the request fingerprint. An exact replay returns the original
record with `replayed`; a changed fingerprint fails closed. Receipt validation also fails closed if
the referenced record or stored result disagrees with current authority.

## Reads and pagination

Get resolves only `(tenantId, spaceId, knowledgeId)`. List is ordered by `(createdAt DESC,
knowledgeId DESC)`, has a hard page limit of 100, and uses an opaque versioned cursor containing the
last tuple. Cross-tenant or cross-space records are never observable.

SQLite and PostgreSQL implement the same `KnowledgeStore` port and conformance suite. PostgreSQL
verification requires a real `CREWON_TEST_POSTGRES_URL`; absence is reported as an explicit skip.

The CrewON Knowledge Library now reads these records only through the typed Control client. The
current UI has no real free-form memory capture or delete/reset contract, so those mutations fail
closed instead of creating placeholder content or calling the legacy app-server.
