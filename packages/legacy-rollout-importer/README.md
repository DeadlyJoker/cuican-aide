# Legacy rollout importer

This package is an import-only compatibility boundary. It reconstructs one immutable Rust rollout JSONL file into a
single atomic `CommitThreadInput`; no Control API or Runtime Worker production path imports it.

Model history is reconstructed from `response_item` and `compacted.replacement_history`. Client-visible message history
is reconstructed separately from durable `event_msg` records, so compaction never turns old UI messages back into model
context. Unsupported model-visible legacy items fail closed instead of being silently dropped.
