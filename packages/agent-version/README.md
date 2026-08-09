# Immutable AgentVersion

`@crewon/agent-version` compiles the complete model-visible and execution policy prefix into an immutable, digest-addressed
record. A stable `agentVersionId` may only be registered once with one digest. Production composition builds Kernel
instructions, ordered Tool definitions, model identity/window, retry budget and compaction threshold from the compiled record;
it does not refresh those fields during a Run.

The registry is deliberately append-only. Updating instructions, Tool order/schema, model identity or execution policy requires
a new `agentVersionId` (or startup fails on the expected digest gate).
