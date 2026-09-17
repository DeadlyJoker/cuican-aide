import { parentPort, workerData } from "node:worker_threads";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import type { CommitThreadInput } from "@crewon/application";

const { path, input } = workerData as {
  path: string;
  input: CommitThreadInput;
};
const store = new SqliteRunStore(path);
try {
  const start = new Promise<void>((resolve) =>
    parentPort!.once("message", () => resolve()),
  );
  parentPort!.postMessage({ kind: "ready" });
  await start;
  try {
    const result = await store.commitThread(input);
    parentPort!.postMessage({
      kind: "result",
      disposition: result.disposition,
      threadId: result.state.threadId,
    });
  } catch (error) {
    parentPort!.postMessage({
      kind: "result",
      code: (error as { code: string }).code,
    });
  }
} finally {
  await store.close();
  parentPort!.close();
}
