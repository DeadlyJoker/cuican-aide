# CrewON architecture navigation

CrewON has one canonical target architecture:

- [ARCHITECTURE_FINAL.md](./ARCHITECTURE_FINAL.md) defines the final-state
  product architecture and is normative for implementation, review, and
  acceptance.
- [artifacts/migration/ws1-implementation-status.md](./artifacts/migration/ws1-implementation-status.md)
  is the single current migration-status index. It records what is actually
  implemented and verified in the shared working tree.
- [MIGRATION_PLAN.md](./MIGRATION_PLAN.md) defines the staged path to the target.

Other architecture-next documents, ADRs, proofs of concept, worktree queues,
and parity reports are design history or supporting evidence. They do not
override the canonical target or the current-status index.

The final direction is intentionally explicit: CrewON owns its TypeScript
Domain, Application, Agent Kernel, Store, Control API, Worker, and public
contracts; OpenAI Agents SDK and every provider-specific SDK are optional
adapters; Rust product orchestration is removed capability by capability after
import, drain, zero-call, parity, and packaged acceptance gates. Rust remains
only where it is the deliberate open implementation at the Tauri/native OS and
Device security boundary.
