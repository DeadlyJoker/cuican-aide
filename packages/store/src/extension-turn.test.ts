import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createExtensionRunBinding } from "@crewon/domain";
import {
  extensionFixture,
  activation,
  receipt,
  scope,
} from "./extension-store.test-support.ts";
import {
  extensionStoreDigester,
  extensionTurnCommit,
  extensionTurnRunInput,
} from "./extension-store-records.ts";
import { extensionTurnInput } from "./extension-turn.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  describe(
    `extension atomic user input + Run + binding (${backend})`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    () => {
      test("concurrent admission and reopened replay retain one message, history item and immutable binding", async (t) => {
        const f = await extensionFixture(t, backend);
        await f.seed();
        const input = extensionTurnInput();
        await f.prepare({
          ...input,
          commit: {
            ...input.turn.run,
            tenantId: input.turn.tenantId,
            idempotency: input.turn.idempotency,
          },
        });
        const results = await Promise.all([
          f.first.store.commitExtensionTurn(input),
          f.second.store.commitExtensionTurn(input),
        ]);
        assert.deepEqual(results.map((value) => value.run.disposition).sort(), [
          "committed",
          "replayed",
        ]);
        assert.deepEqual(results[0]!.binding, input.binding);
        assert.equal(await f.count("messages"), 1);
        assert.equal(await f.count("model_history_items"), 1);
        assert.equal(await f.count("extension_run_bindings"), 1);
        assert.equal(
          (await f.first.parent.loadThread(input.binding))?.revision,
          2,
        );
        assert.deepEqual(
          await f.first.parent.listMessages(input.binding, 0, 10),
          input.turn.thread.messages,
        );
        assert.deepEqual(
          await f.first.parent.listModelHistoryItems(input.binding, 0, 10),
          input.turn.thread.history.items,
        );
        const reopened = await f.open();
        const replay = await reopened.store.loadExtensionTurnReceipt({
          ...scope,
          receipt: input.receipt,
        });
        assert.equal(replay?.turn.disposition, "replayed");
        assert.equal(replay?.run.disposition, "replayed");
        assert.equal(
          replay?.turn.messages[0]?.contentDigest,
          input.binding.inputDigest,
        );
        assert.deepEqual(
          (
            await reopened.store.loadExtensionRunReceipt({
              ...scope,
              receipt: input.receipt,
            })
          )?.binding,
          input.binding,
        );
        const ordinaryReceipt = await reopened.parent.loadTurnStartReceipt({
          tenantId: input.turn.tenantId,
          threadId: input.binding.threadId,
          idempotency: extensionTurnCommit(input).idempotency,
        });
        assert.deepEqual(ordinaryReceipt, replay?.turn);
      });

      test("binding failure rolls back user input, history, both receipts, outbox and work queue", async (t) => {
        const f = await extensionFixture(t, backend);
        await f.seed();
        const input = extensionTurnInput();
        await f.prepare({
          ...input,
          commit: {
            ...input.turn.run,
            tenantId: input.turn.tenantId,
            idempotency: input.turn.idempotency,
          },
        });
        await f.failBindings(true);
        await assert.rejects(
          f.first.store.commitExtensionTurn(input),
          /test_binding_failure/,
        );
        for (const table of [
          "messages",
          "model_history_items",
          "run_snapshots",
          "extension_run_bindings",
          "outbox",
          "work_items",
          "idempotency_receipts",
        ])
          assert.equal(await f.count(table), 0, table);
        assert.equal(
          (await f.first.parent.loadThread(input.binding))?.revision,
          1,
        );
        assert.equal(
          await f.first.store.loadExtensionTurnReceipt({
            ...scope,
            receipt: input.receipt,
          }),
          null,
        );
        await f.failBindings(false);
        assert.equal(
          (await f.second.store.commitExtensionTurn(input)).run.disposition,
          "committed",
        );
      });

      test("input digest, message/history correlation and thread revision are validated before any dispatch", async (t) => {
        const f = await extensionFixture(t, backend);
        await f.seed();
        const input = extensionTurnInput();
        await f.prepare({
          ...input,
          commit: {
            ...input.turn.run,
            tenantId: input.turn.tenantId,
            idempotency: input.turn.idempotency,
          },
        });
        const wrong = createExtensionRunBinding(
          { ...input.binding, inputDigest: `sha256:${"b".repeat(64)}` },
          extensionStoreDigester,
        );
        await assert.rejects(
          f.first.store.commitExtensionTurn({ ...input, binding: wrong }),
          /extension_turn_input_mismatch/,
        );
        await assert.rejects(
          f.first.store.commitExtensionTurn({
            ...input,
            turn: {
              ...input.turn,
              thread: {
                ...input.turn.thread,
                messages: [
                  { ...input.turn.thread.messages[0]!, content: "other input" },
                ],
              },
            },
          }),
          /turn_start_message_mismatch/,
        );
        await assert.rejects(
          f.first.store.commitExtensionTurn({
            ...input,
            turn: {
              ...input.turn,
              thread: { ...input.turn.thread, expectedRevision: 99 },
            },
          }),
          (error: unknown) =>
            error instanceof Error &&
            "code" in error &&
            error.code === "revision_conflict",
        );
        assert.equal(await f.count("messages"), 0);
        assert.equal(await f.count("work_items"), 0);
      });

      test("disable or revoke denies new input; existing admission replays without another message", async (t) => {
        const f = await extensionFixture(t, backend);
        await f.seed();
        const input = extensionTurnInput();
        await f.prepare({
          ...input,
          commit: {
            ...input.turn.run,
            tenantId: input.turn.tenantId,
            idempotency: input.turn.idempotency,
          },
        });
        const saved = await f.first.store.commitExtensionTurn(input);
        for (const [index, state] of (
          ["disabled", "revoked"] as const
        ).entries()) {
          await f.first.store.saveExtensionActivation({
            activation: activation(undefined, {
              revision: index + 2,
              state,
              target: null,
            }),
            expectedRevision: index + 1,
            receipt: receipt(`state-${state}`),
          });
          const next = extensionTurnInput(`run-${state}`);
          await f.prepare({
            ...next,
            commit: {
              ...next.turn.run,
              tenantId: next.turn.tenantId,
              idempotency: next.turn.idempotency,
            },
          });
          await assert.rejects(
            f.first.store.commitExtensionTurn({
              ...next,
              expectedActivationRevision: index + 2,
            }),
            /extension_generation_disabled|extension_access_revoked/,
          );
          assert.deepEqual(
            (await f.second.store.commitExtensionTurn(input)).binding,
            saved.binding,
          );
        }
        assert.equal(await f.count("messages"), 1);
        assert.equal(await f.count("extension_run_bindings"), 1);
      });

      test("unknown admission receipt version is rejected while legacy run-only receipts retain their reader", async (t) => {
        const f = await extensionFixture(t, backend);
        await f.seed();
        const input = extensionTurnInput();
        await f.prepare({
          ...input,
          commit: {
            ...input.turn.run,
            tenantId: input.turn.tenantId,
            idempotency: input.turn.idempotency,
          },
        });
        await f.first.store.commitExtensionTurn(input);
        await f.sql(
          backend === "sqlite"
            ? "UPDATE extension_mutation_receipts SET result_json = json_set(result_json, '$.schemaVersion', 'future') WHERE kind = 'task';"
            : `UPDATE ${f.prefix}extension_mutation_receipts SET result_json = jsonb_set(result_json, '{schemaVersion}', '"future"') WHERE kind = 'task';`,
        );
        await assert.rejects(
          f.first.store.loadExtensionTurnReceipt({
            ...scope,
            receipt: input.receipt,
          }),
          /extension_turn_receipt_invalid/,
        );
        const legacy = extensionTurnInput("legacy-run");
        const runOnly = extensionTurnRunInput(legacy);
        await f.prepare(runOnly);
        await f.first.store.commitExtensionRun(runOnly);
        assert.deepEqual(
          (
            await f.first.store.loadExtensionRunReceipt({
              ...scope,
              receipt: legacy.receipt,
            })
          )?.binding,
          legacy.binding,
        );
        await assert.rejects(
          f.first.store.loadExtensionTurnReceipt({
            ...scope,
            receipt: legacy.receipt,
          }),
          /extension_turn_receipt_invalid/,
        );
        await assert.rejects(
          f.first.store.commitExtensionTurn(legacy),
          /extension_turn_receipt_invalid/,
        );
        assert.equal(
          (await f.first.parent.listMessages(legacy.binding, 0, 10)).length,
          0,
        );
      });
    },
  );
}
