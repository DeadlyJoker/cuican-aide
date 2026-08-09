import { registerRunApplicationConformance } from "./run-application-conformance.test-support.ts";
import { InMemoryRunStore } from "./in-memory-run-store.ts";
import { SqliteRunStore } from "./sqlite-run-store.ts";

registerRunApplicationConformance(
  "RunApplicationService + InMemoryRunStore",
  () => new InMemoryRunStore(),
);

registerRunApplicationConformance(
  "RunApplicationService + SqliteRunStore",
  () => new SqliteRunStore(":memory:"),
);
