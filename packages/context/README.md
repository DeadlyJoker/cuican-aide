# CrewON Context

`@crewon/context` owns provider-neutral prompt projection rules. It does not own durable Thread or
Run state and does not call a model SDK.

The first boundary is cache-stable Tool history normalization. A matched history is returned
unchanged. Orphan Tool results are removed, and a Tool call that has no later matching result gets
the Rust-compatible `aborted` result immediately after the call. Every repair is reported without
copying message, Tool input, or Tool output content. A repaired projection must invalidate any
provider checkpoint and use manual history replay.

New writes remain strict: the Store rejects orphan or missing Tool pairs. Normalization exists for
legacy import, compaction, resume and fork projections; it is not permission to persist malformed
history.

Durable compaction is represented by an append-only Model History item. Projection selects the
latest compaction, restores its bounded retained user messages and Rust-compatible handoff summary,
then appends the untouched canonical tail. The compaction item ID is the context revision: provider
checkpoints from an older revision are never reused. Both item and UTF-8 byte limits are enforced;
Tool-pair repair reserves capacity for its synthetic `aborted` result.
