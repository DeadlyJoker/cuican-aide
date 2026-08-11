import { registerRunStoreConformance } from "./run-store-conformance.test-support.ts";
import { registerRunExecutionStoreConformance } from "./run-execution-store-conformance.test-support.ts";
import { registerThreadStoreConformance } from "./thread-store-conformance.test-support.ts";
import { registerAgentVersionStoreConformance } from "./agent-version-store-conformance.test-support.ts";
import { registerAgentVersionReleaseStoreConformance } from "./agent-version-release-store-conformance.test-support.ts";
import { InMemoryRunStore } from "./in-memory-run-store.ts";
import { registerTurnStartStoreConformance } from "./turn-start-store-conformance.test-support.ts";
import { registerThreadGoalMutationStoreConformance } from "./thread-goal-mutation-store-conformance.test-support.ts";
import { registerThreadRollbackStoreConformance } from "./thread-rollback-store-conformance.test-support.ts";
import { registerAutomationStoreConformance } from "./automation-store-conformance.test-support.ts";

registerAutomationStoreConformance(
  "InMemoryRunStore Automation authority",
  () => new InMemoryRunStore(),
);

registerRunStoreConformance(
  "InMemoryRunStore",
  (clock) => new InMemoryRunStore({ clock }),
);

registerAgentVersionStoreConformance(
  "InMemoryRunStore AgentVersion authority",
  () => new InMemoryRunStore(),
);

registerAgentVersionReleaseStoreConformance(
  "InMemoryRunStore AgentVersion release authority",
  () => new InMemoryRunStore(),
);

registerThreadStoreConformance(
  "InMemoryRunStore Thread authority",
  (clock) => new InMemoryRunStore({ clock }),
);

registerRunExecutionStoreConformance(
  "InMemoryRunStore execution authority",
  (clock) => new InMemoryRunStore({ clock }),
);

registerTurnStartStoreConformance(
  "InMemoryRunStore atomic Turn start",
  () => new InMemoryRunStore(),
);

registerThreadGoalMutationStoreConformance(
  "InMemoryRunStore atomic Goal mutation",
  () => new InMemoryRunStore(),
);

registerThreadRollbackStoreConformance(
  "InMemoryRunStore append-only Thread rollback",
  (clock) => new InMemoryRunStore({ clock }),
);
