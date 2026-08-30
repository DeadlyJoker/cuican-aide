import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ThreadApplicationService,
  type ActorContext,
  type ApplicationIdGenerator,
  type ApplicationIdKind,
} from "@crewon/application";
import { projectModelHistory } from "@crewon/context";
import { validateModelHistoryItem } from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";

import {
  compileLegacyRolloutImport,
  LegacyRolloutImportError,
} from "./legacy-rollout-importer.ts";

test("imports AR-026 and preserves the AR-027 compact/resume/fork model view", async (context) => {
  const reference = JSON.parse(
    readFileSync(
      new URL(
        "../../test-contracts/fixtures/legacy-rollout-resume-fork.reference.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Readonly<{
    rollout: readonly Readonly<Record<string, unknown>>[];
    expected: Readonly<{
      initialMessages: readonly unknown[];
      importedModelView: readonly unknown[];
      userTextViews: Readonly<{
        afterCompact: readonly string[];
        afterResume: readonly string[];
        afterFork: readonly string[];
      }>;
      forkThroughHistorySequence: number;
    }>;
  }>;
  const jsonl = `${reference.rollout.map((line) => JSON.stringify(line)).join("\n")}\n`;
  const ids = new SequentialIds();
  const digester = { sha256 };
  const plan = compileLegacyRolloutImport(
    jsonl,
    {
      tenantId: ACTOR.tenantId,
      spaceId: ACTOR.spaceId,
      actorId: ACTOR.actorId,
      threadId: "imported-thread",
      title: "Imported rollout",
      importedAt: "2026-01-02T04:00:00Z",
      idempotencyKey: "import-rollout-1",
    },
    {
      ids: {
        nextThreadEventId: () => ids.nextId("threadEvent"),
        nextMessageId: () => ids.nextId("message"),
        nextModelHistoryItemId: () => ids.nextId("modelHistoryItem"),
      },
      digester,
    },
  );
  assert.deepEqual(
    plan.initialMessages.map(({ role, content }) => ({ role, content })),
    reference.expected.initialMessages,
  );
  for (const item of plan.commit.history.items) {
    assert.doesNotThrow(() => validateModelHistoryItem(item));
  }
  assert.equal(
    plan.commit.history.items.filter((item) => item.type === "compaction")
      .length,
    1,
  );
  assert.deepEqual(
    projectModelHistory(plan.commit.history.items).items,
    reference.expected.importedModelView,
  );

  const directory = mkdtempSync(join(tmpdir(), "crewon-rollout-import-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "runtime.sqlite");
  const store = new SqliteRunStore(path);
  const imported = await store.commitThread(plan.commit);
  assert.equal(imported.disposition, "committed");
  assert.equal((await store.commitThread(plan.commit)).disposition, "replayed");
  await store.close();

  const reopened = new SqliteRunStore(path);
  const threads = new ThreadApplicationService({
    store: reopened,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-01-02T04:00:01Z" },
    ids,
    digester,
  });
  const restored = await loadHistory(reopened, "imported-thread");
  assert.deepEqual(
    userTexts(restored),
    reference.expected.userTextViews.afterCompact,
  );

  const forked = await threads.forkThread(ACTOR, {
    kind: "thread.fork",
    idempotencyKey: "fork-imported-1",
    sourceThreadId: "imported-thread",
    expectedSourceRevision: imported.state.revision,
    throughHistorySequence: reference.expected.forkThroughHistorySequence,
  });
  await threads.appendMessage(ACTOR, {
    kind: "thread.message.append",
    idempotencyKey: "fork-message-1",
    threadId: forked.state.threadId,
    expectedRevision: forked.state.revision,
    role: "user",
    content: "AFTER_FORK",
  });
  await threads.appendMessage(ACTOR, {
    kind: "thread.message.append",
    idempotencyKey: "resume-message-1",
    threadId: "imported-thread",
    expectedRevision: imported.state.revision,
    role: "user",
    content: "AFTER_RESUME",
  });

  assert.deepEqual(
    userTexts(await loadHistory(reopened, "imported-thread")),
    reference.expected.userTextViews.afterResume,
  );
  assert.deepEqual(
    userTexts(await loadHistory(reopened, forked.state.threadId)),
    reference.expected.userTextViews.afterFork,
  );
  await reopened.close();
});

test("fails closed when a legacy model item cannot be represented losslessly", () => {
  const jsonl = [
    {
      timestamp: "2026-01-02T03:04:05Z",
      type: "session_meta",
      payload: { id: "legacy-thread" },
    },
    {
      timestamp: "2026-01-02T03:04:06Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "sensitive://image" }],
      },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n");

  assert.throws(
    () =>
      compileLegacyRolloutImport(
        jsonl,
        {
          tenantId: "tenant-1",
          spaceId: "space-1",
          actorId: "actor-1",
          threadId: "thread-1",
          title: null,
          importedAt: "2026-01-02T04:00:00Z",
          idempotencyKey: "import-1",
        },
        {
          ids: {
            nextThreadEventId: () => "event-1",
            nextMessageId: () => "message-1",
            nextModelHistoryItemId: () => "history-1",
          },
          digester: { sha256 },
        },
      ),
    (error) =>
      error instanceof LegacyRolloutImportError &&
      error.code === "legacy_message_content_unsupported",
  );
});

const ACTOR: ActorContext = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
};

class SequentialIds implements ApplicationIdGenerator {
  readonly #counts = new Map<ApplicationIdKind, number>();

  nextId(kind: ApplicationIdKind): string {
    const count = (this.#counts.get(kind) ?? 0) + 1;
    this.#counts.set(kind, count);
    return `${kind}-${count}`;
  }
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function loadHistory(
  store: SqliteRunStore,
  threadId: string,
): Promise<readonly import("@crewon/domain").ModelHistoryItem[]> {
  const items: import("@crewon/domain").ModelHistoryItem[] = [];
  let cursor = 0;
  while (true) {
    const page = await store.listModelHistoryItems(
      { tenantId: ACTOR.tenantId, threadId },
      cursor,
      100,
    );
    if (page.length === 0) {
      return items;
    }
    items.push(...page);
    cursor = page.at(-1)!.sequence;
  }
}

function userTexts(
  history: readonly import("@crewon/domain").ModelHistoryItem[],
): readonly string[] {
  return projectModelHistory(history).items.flatMap((item) =>
    item.type === "message" && item.role === "user" ? [item.content] : [],
  );
}
