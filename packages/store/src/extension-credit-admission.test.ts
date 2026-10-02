import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, test, type TestContext } from "node:test";
import { Client } from "pg";
import {
  ApplicationError,
  ExtensionTaskApplicationService,
  type CreateExtensionTaskCommand,
  type ExtensionCreditQuotePort,
  type ExtensionGenerationCreditQuote,
  type ExtensionStore,
} from "@crewon/application";
import {
  createExtensionCreditAdmission,
  type CreditScope,
} from "@crewon/domain";
import {
  actor,
  activateCommand,
  configurationServiceFixture,
  saveCommand,
} from "./extension-configuration-service.test-support.ts";
import { digest, scope, timestamp } from "./extension-store.test-support.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";

type Backend = "sqlite" | "postgres";
type Storage = Awaited<ReturnType<typeof configurationServiceFixture>>["first"];
type QuoteCall = Parameters<ExtensionCreditQuotePort["quoteGeneration"]>[0];

const generationInput = {
  prompt: "A concept image for the credit admission fixture.",
};
const command: CreateExtensionTaskCommand = {
  pluginId: scope.pluginId,
  threadId: "credit-task-thread",
  expectedThreadRevision: 1,
  idempotencyKey: "credit-task-one",
  intent: {
    kind: "generate",
    input: generationInput,
  },
};
const creditScope: CreditScope = {
  tenantId: actor.tenantId,
  principalId: actor.principalId,
  poolId: "credit-admission-fixture",
};
// These amounts and revisions are deterministic fixtures, not a product price policy.
const fixtureQuote: ExtensionGenerationCreditQuote = {
  poolId: creditScope.poolId,
  priceRevision: 1,
  quotedCredits: "30",
};
const taskTables = [
  "messages",
  "model_history_items",
  "run_snapshots",
  "extension_run_bindings",
  "outbox",
  "work_items",
  "idempotency_receipts",
  "thread_idempotency_receipts",
  "extension_mutation_receipts",
] as const;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const applicationFailure =
  (code: string, causePattern?: RegExp) => (error: unknown) =>
    error instanceof ApplicationError &&
    error.code === code &&
    (causePattern === undefined ||
      (error.cause instanceof Error && causePattern.test(error.cause.message)));

async function fixture(
  t: TestContext,
  backend: Backend,
  options: {
    schema?: "migrated" | "absent";
    balance?: string | null;
    pricing?: "quoted" | "unpriced";
  } = {},
) {
  const f = await configurationServiceFixture(t, backend);
  await f.seedDeployment();
  await f.service.saveConfiguration(actor, saveCommand);
  await f.service.setActivation(actor, activateCommand);
  await seedThread(f.first.parent, { ...actor, threadId: command.threadId });
  const quoteState = {
    quote: fixtureQuote,
    calls: [] as QuoteCall[],
    error: null as Error | null,
    gate: null as Promise<void> | null,
    entered: null as (() => void) | null,
    prepare: null as ((input: QuoteCall) => Promise<void>) | null,
  };
  const quotes: ExtensionCreditQuotePort = {
    async quoteGeneration(input) {
      quoteState.calls.push(structuredClone(input));
      quoteState.entered?.();
      await quoteState.gate;
      if (quoteState.error !== null) throw quoteState.error;
      await quoteState.prepare?.(input);
      return structuredClone(quoteState.quote);
    },
  };
  const create = (
    input: {
      storage?: Storage;
      pricing?: "quoted" | "unpriced";
      extensions?: ExtensionStore;
    } = {},
  ) =>
    new ExtensionTaskApplicationService({
      ...f.dependencies,
      store: (input.storage ?? f.first).parent,
      extensions: input.extensions ?? (input.storage ?? f.first).store,
      operations: f.operations,
      ids: { nextId: () => randomUUID() },
      ...((input.pricing ?? options.pricing ?? "quoted") === "quoted"
        ? { creditQuotes: quotes }
        : {}),
    });
  const credits = f.first.parent.pluginCreditStore();
  if ((options.schema ?? "migrated") === "migrated") {
    await f.first.store.migrateCredits();
    await f.second.store.migrateCredits();
    const balance = options.balance === undefined ? "100" : options.balance;
    if (balance !== null)
      await credits.grant({
        scope: creditScope,
        grantId: "fixture-funding",
        credits: balance,
      });
  }
  const counts = async () =>
    Object.fromEntries(
      await Promise.all(
        taskTables.map(async (table) => [table, await f.count(table)]),
      ),
    );
  return {
    ...f,
    credits,
    quoteState,
    create,
    counts,
    task: create(),
    secondTask: create({ storage: f.second }),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function failInsert(
  f: Fixture,
  backend: Backend,
  table:
    | "extension_run_bindings"
    | "extension_mutation_receipts"
    | "extension_credit_admissions",
  operation: "enable" | "disable",
) {
  const taskOnly = table === "extension_mutation_receipts";
  if (backend === "sqlite") {
    await f.sql(
      operation === "enable"
        ? `CREATE TRIGGER fail_credit_admission BEFORE INSERT ON ${table} ${taskOnly ? "WHEN NEW.kind = 'task'" : ""} BEGIN SELECT RAISE(ABORT, 'credit_admission_test_failure'); END;`
        : "DROP TRIGGER fail_credit_admission;",
    );
    return;
  }
  await f.sql(
    operation === "enable"
      ? `CREATE FUNCTION ${f.prefix}fail_credit_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'credit_admission_test_failure'; END; $$;
         CREATE TRIGGER fail_credit_admission BEFORE INSERT ON ${f.prefix}${table} FOR EACH ROW ${taskOnly ? "WHEN (NEW.kind = 'task')" : ""} EXECUTE FUNCTION ${f.prefix}fail_credit_admission();`
      : `DROP TRIGGER fail_credit_admission ON ${f.prefix}${table}; DROP FUNCTION ${f.prefix}fail_credit_admission();`,
  );
}

/** Observe actual SQL only during the legacy task; the production constructors stay unchanged. */
function observeCreditSql(backend: Backend) {
  const statements: string[] = [];
  const restores: (() => void)[] = [];
  const observe = (prototype: object, method: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
    assert.ok(descriptor && typeof descriptor.value === "function");
    const original = descriptor.value as (...args: unknown[]) => unknown;
    Object.defineProperty(prototype, method, {
      ...descriptor,
      value: function (this: unknown, ...args: unknown[]) {
        const query = args[0];
        const sql =
          typeof query === "string"
            ? query
            : query !== null && typeof query === "object" && "text" in query
              ? query.text
              : null;
        if (
          typeof sql === "string" &&
          /(?:plugin_credit|extension_credit)/u.test(sql)
        )
          statements.push(sql);
        return Reflect.apply(original, this, args);
      },
    });
    restores.push(() => Object.defineProperty(prototype, method, descriptor));
  };
  if (backend === "sqlite") {
    observe(DatabaseSync.prototype, "prepare");
    observe(DatabaseSync.prototype, "exec");
  } else observe(Client.prototype, "query");
  return {
    statements,
    restore() {
      for (const restore of restores.reverse()) restore();
      restores.length = 0;
    },
  };
}

for (const backend of ["sqlite", "postgres"] as const) {
  describe(
    `extension generation credit admission (${backend})`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    () => {
      test("only trusted generation quotes can freeze the current principal's account", async (t) => {
        const f = await fixture(t, backend);
        await assert.rejects(
          f.task.createTask(actor, {
            ...command,
            creditAdmission: { quotedCredits: "1" },
          } as CreateExtensionTaskCommand),
          /extension_command_invalid/,
        );
        await assert.rejects(
          f.task.createTask(actor, {
            ...command,
            intent: {
              kind: "generate",
              input: { prompt: "fixture", quotedCredits: "1" },
            },
          }),
          /extension_task_input_invalid/,
        );
        assert.equal(f.quoteState.calls.length, 0);
        const result = await f.task.createTask(actor, command);
        assert.equal(f.quoteState.calls.length, 1);
        const quoted = f.quoteState.calls[0]!;
        assert.deepEqual(quoted.actor, actor);
        assert.deepEqual(quoted.binding, result.binding);
        assert.deepEqual(quoted.input, generationInput);
        assert.equal(
          quoted.commandRequestDigest,
          result.creditAdmission!.commandRequestDigest,
        );
        assert.deepEqual(
          result.creditAdmission!.reservation.scope,
          creditScope,
        );
        assert.equal(result.creditAdmission!.reservation.quotedCredits, "30");
        assert.equal(result.creditAdmission!.reservation.priceRevision, 1);
        assert.equal(
          result.creditAdmission!.reservation.reservationId,
          result.binding.runId,
        );
        assert.deepEqual(
          await f.first.store.loadExtensionCreditAdmission(result.binding),
          result.creditAdmission,
        );
        const hold = await f.credits.getReservation({
          scope: creditScope,
          reservationId: result.binding.runId,
        });
        assert.equal(hold!.state, "reserved");
        assert.equal(
          hold!.requestDigest,
          result.creditAdmission!.reservation.requestDigest,
        );
        assert.equal(
          (await f.credits.getAccount(creditScope))!.availableCredits,
          "70",
        );
        assert.equal(
          (await f.credits.getAccount(creditScope))!.reservedCredits,
          "30",
        );
      });

      test("concurrent same-key admission and reopened replay retain one Turn, hold and original quote", async (t) => {
        const f = await fixture(t, backend);
        const results = await Promise.all([
          f.task.createTask(actor, command),
          f.secondTask.createTask(actor, command),
        ]);
        assert.deepEqual(
          results.map((result) => result.run.disposition).sort(),
          ["committed", "replayed"],
        );
        const saved = results.find(
          (result) => result.run.disposition === "committed",
        )!;
        for (const result of results) {
          assert.deepEqual(result.binding, saved.binding);
          assert.deepEqual(result.creditAdmission, saved.creditAdmission);
        }
        for (const table of [
          "messages",
          "model_history_items",
          "run_snapshots",
          "extension_run_bindings",
          "work_items",
          "plugin_credit_reservations",
          "extension_credit_admissions",
        ])
          assert.equal(await f.count(table), 1, table);
        assert.equal(await f.count("plugin_credit_entries"), 2);
        const quotedBeforeReplay = f.quoteState.calls.length;
        f.quoteState.quote = {
          ...fixtureQuote,
          priceRevision: 2,
          quotedCredits: "55",
        };
        f.quoteState.error = new Error(
          "replay must not ask a newer price policy",
        );
        await f.first.parent.close();
        await f.second.parent.close();
        const reopened = await f.open();
        const replay = await f
          .create({ storage: reopened })
          .createTask(actor, command);
        assert.equal(replay.turn.disposition, "replayed");
        assert.deepEqual(replay.binding, saved.binding);
        assert.deepEqual(replay.creditAdmission, saved.creditAdmission);
        assert.equal(f.quoteState.calls.length, quotedBeforeReplay);
        const credits = reopened.parent.pluginCreditStore();
        assert.equal(
          (await credits.getAccount(creditScope))!.availableCredits,
          "70",
        );
        assert.equal(
          (await credits.getAccount(creditScope))!.reservedCredits,
          "30",
        );
        assert.equal(await f.count("messages"), 1);
        assert.equal(await f.count("model_history_items"), 1);
        assert.equal(await f.count("plugin_credit_reservations"), 1);
        assert.equal(await f.count("extension_credit_admissions"), 1);
        assert.equal(await f.count("plugin_credit_entries"), 2);
      });

      test("query tasks and cursor/receipt rereads never freeze another generation fee", async (t) => {
        const f = await fixture(t, backend);
        const generated = await f.task.createTask(actor, command);
        const operationId = randomUUID();
        await f.operations.reserveExternalOperation({
          tenantId: actor.tenantId,
          runId: generated.binding.runId,
          bindingDigest: generated.binding.bindingDigest,
          operationId,
          correlationId: operationId,
          executionId: "credit-query-execution",
          idempotencyKey: "credit-query-operation",
          actionDigest: digest,
          requestDigest: digest,
          createdAt: timestamp,
        });
        await seedThread(f.first.parent, {
          ...actor,
          threadId: "credit-query-thread",
        });
        const query: CreateExtensionTaskCommand = {
          ...command,
          threadId: "credit-query-thread",
          idempotencyKey: "credit-query-one",
          intent: {
            kind: "query",
            sourceRunId: generated.binding.runId,
            operationId,
          },
        };
        f.quoteState.error = new Error(
          "query must not quote another generation",
        );
        const queried = await f.task.createTask(actor, query);
        assert.equal(queried.run.disposition, "committed");
        assert.equal(queried.creditAdmission, undefined);
        assert.equal(
          await f.first.store.loadExtensionCreditAdmission(queried.binding),
          null,
        );
        assert.equal(
          (await f.secondTask.createTask(actor, query)).run.disposition,
          "replayed",
        );
        const credit = generated.creditAdmission!;
        const receiptInput = {
          ...scope,
          receipt: {
            actorId: credit.actorId,
            idempotencyKey: credit.commandIdempotencyKey,
            requestDigest: credit.commandRequestDigest,
          },
        };
        const originalEvents = await f.first.parent.listRunEvents(
          generated.binding,
          0,
          100,
        );
        const cursor = originalEvents[0]!.sequence;
        for (let attempt = 0; attempt < 2; attempt++) {
          assert.deepEqual(
            (await f.first.store.loadExtensionTurnReceipt(receiptInput))!
              .creditAdmission,
            credit,
          );
          assert.deepEqual(
            await f.first.parent.listRunEvents(generated.binding, cursor, 100),
            originalEvents.filter((event) => event.sequence > cursor),
          );
        }
        assert.equal(f.quoteState.calls.length, 1);
        assert.equal(await f.count("messages"), 2);
        assert.equal(await f.count("model_history_items"), 2);
        assert.equal(await f.count("plugin_credit_reservations"), 1);
        assert.equal(await f.count("extension_credit_admissions"), 1);
        assert.equal(await f.count("plugin_credit_entries"), 2);
        assert.equal(
          (await f.credits.getAccount(creditScope))!.availableCredits,
          "70",
        );
      });

      test("insufficient balance commits no Run, input, dispatch, receipt or hold", async (t) => {
        const f = await fixture(t, backend, { balance: "20" });
        const before = await f.counts();
        const account = await f.credits.getAccount(creditScope);
        await assert.rejects(
          f.task.createTask(actor, command),
          /plugin_credit_insufficient_balance/,
        );
        assert.deepEqual(await f.counts(), before);
        assert.deepEqual(await f.credits.getAccount(creditScope), account);
        assert.equal(await f.count("plugin_credit_reservations"), 0);
        assert.equal(await f.count("extension_credit_admissions"), 0);
        assert.equal(await f.count("plugin_credit_entries"), 1);
        assert.equal(
          (await f.first.parent.loadThread({
            ...actor,
            threadId: command.threadId,
          }))!.revision,
          1,
        );
      });

      for (const table of [
        "extension_run_bindings",
        "extension_mutation_receipts",
        "extension_credit_admissions",
      ] as const)
        test(`${table} insertion failure rolls back the Turn, quote hold and all receipts`, async (t) => {
          const f = await fixture(t, backend);
          const before = await f.counts();
          const account = await f.credits.getAccount(creditScope);
          await failInsert(f, backend, table, "enable");
          try {
            await assert.rejects(
              f.task.createTask(actor, command),
              applicationFailure(
                "extension_service_unavailable",
                /credit_admission_test_failure/,
              ),
            );
          } finally {
            await failInsert(f, backend, table, "disable");
          }
          assert.deepEqual(await f.counts(), before);
          assert.deepEqual(await f.credits.getAccount(creditScope), account);
          assert.equal(await f.count("plugin_credit_reservations"), 0);
          assert.equal(await f.count("extension_credit_admissions"), 0);
          assert.equal(await f.count("plugin_credit_entries"), 1);
          assert.equal(
            (await f.first.parent.loadThread({
              ...actor,
              threadId: command.threadId,
            }))!.revision,
            1,
          );
          const retry = await f.secondTask.createTask(actor, command);
          assert.equal(retry.run.disposition, "committed");
          assert.equal(await f.count("messages"), 1);
          assert.equal(await f.count("plugin_credit_reservations"), 1);
          assert.equal(await f.count("extension_credit_admissions"), 1);
          assert.equal(
            (await f.credits.getAccount(creditScope))!.availableCredits,
            "70",
          );
        });

      test("an orphaned hold cannot be reused to admit a new task without its original atomic link", async (t) => {
        const f = await fixture(t, backend);
        const before = await f.counts();
        f.quoteState.prepare = async (quoted) => {
          const admission = createExtensionCreditAdmission(
            {
              binding: quoted.binding,
              receipt: {
                actorId: quoted.actor.actorId,
                idempotencyKey: command.idempotencyKey,
                requestDigest: quoted.commandRequestDigest,
              },
              principalId: quoted.actor.principalId,
              ...fixtureQuote,
            },
            extensionStoreDigester,
          );
          // Deliberately simulate an independently persisted hold with no Turn/link/receipt.
          await f.credits.reserve(admission.reservation);
        };
        await assert.rejects(
          f.task.createTask(actor, command),
          applicationFailure("extension_credit_orphaned_reservation"),
        );
        assert.deepEqual(await f.counts(), before);
        const quoted = f.quoteState.calls[0]!;
        assert.equal(await f.first.parent.loadRun(quoted.binding), null);
        assert.equal(
          await f.first.store.loadExtensionCreditAdmission(quoted.binding),
          null,
        );
        assert.equal(await f.count("extension_credit_admissions"), 0);
        assert.equal(await f.count("plugin_credit_reservations"), 1);
        assert.equal(await f.count("plugin_credit_entries"), 2);
        assert.equal(
          (await f.credits.getAccount(creditScope))!.availableCredits,
          "70",
        );
        assert.equal(
          (await f.credits.getAccount(creditScope))!.reservedCredits,
          "30",
        );
      });

      test("another principal with the same actor cannot replay the original billed account", async (t) => {
        const f = await fixture(t, backend);
        const saved = await f.task.createTask(actor, command);
        const quoteCalls = f.quoteState.calls.length;
        const otherPrincipal = { ...actor, principalId: "different-principal" };
        await assert.rejects(
          f.secondTask.createTask(otherPrincipal, command),
          /extension_credit.*(?:owner|principal|identity)|authorization_denied/,
        );
        assert.equal(f.quoteState.calls.length, quoteCalls);
        assert.equal(
          await f.credits.getAccount({
            ...creditScope,
            principalId: otherPrincipal.principalId,
          }),
          null,
        );
        assert.equal(await f.count("messages"), 1);
        assert.equal(await f.count("plugin_credit_reservations"), 1);
        assert.deepEqual(
          await f.first.store.loadExtensionCreditAdmission(saved.binding),
          saved.creditAdmission,
        );
        assert.equal(
          (await f.credits.getAccount(creditScope))!.availableCredits,
          "70",
        );
      });

      test("an unpriced legacy task with no credit schema performs no credit SQL", async (t) => {
        const f = await fixture(t, backend, {
          schema: "absent",
          balance: null,
          pricing: "unpriced",
        });
        await assert.rejects(
          f.count("plugin_credit_accounts"),
          /no such table|does not exist/,
        );
        await assert.rejects(
          f.count("extension_credit_admissions"),
          /no such table|does not exist/,
        );
        const observed = observeCreditSql(backend);
        t.after(() => observed.restore());
        try {
          const saved = await f.task.createTask(actor, command);
          assert.equal(saved.run.disposition, "committed");
          assert.equal(Object.hasOwn(saved, "creditAdmission"), false);
          assert.equal(
            (await f.secondTask.createTask(actor, command)).run.disposition,
            "replayed",
          );
          assert.deepEqual(observed.statements, []);
        } finally {
          observed.restore();
        }
        assert.equal(f.quoteState.calls.length, 0);
        assert.equal(await f.count("messages"), 1);
        assert.equal(await f.count("model_history_items"), 1);
        assert.equal(await f.count("work_items"), 1);
        await assert.rejects(
          f.count("plugin_credit_accounts"),
          /no such table|does not exist/,
        );
        await assert.rejects(
          f.count("extension_credit_admissions"),
          /no such table|does not exist/,
        );
      });

      test("a failing or malformed server quote never falls back to a free task", async (t) => {
        const f = await fixture(t, backend);
        const before = await f.counts();
        const account = await f.credits.getAccount(creditScope);
        f.quoteState.error = new Error("credit_quote_fixture_unavailable");
        await assert.rejects(f.task.createTask(actor, command), /credit_quote/);
        f.quoteState.error = null;
        // This deliberately invalid decimal is not a proposed product price.
        f.quoteState.quote = { ...fixtureQuote, quotedCredits: "30.5" };
        await assert.rejects(
          f.task.createTask(actor, command),
          applicationFailure("extension_credit_quote_invalid"),
        );
        assert.equal(f.quoteState.calls.length, 2);
        assert.deepEqual(await f.counts(), before);
        assert.deepEqual(await f.credits.getAccount(creditScope), account);
        assert.equal(await f.count("plugin_credit_reservations"), 0);
        assert.equal(await f.count("extension_credit_admissions"), 0);
        assert.equal(await f.count("plugin_credit_entries"), 1);
      });

      test("an old Store adapter cannot silently ignore a configured generation fee", async (t) => {
        const f = await fixture(t, backend, {
          schema: "absent",
          balance: null,
        });
        const before = await f.counts();
        const legacy = new Proxy(f.first.store, {
          get(target, property) {
            if (property === "creditAdmissionVersion") return undefined;
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        await assert.rejects(
          f.create({ extensions: legacy }).createTask(actor, command),
          /extension_credit_admission_unavailable/,
        );
        assert.equal(f.quoteState.calls.length, 0);
        assert.deepEqual(await f.counts(), before);
        await assert.rejects(
          f.count("plugin_credit_accounts"),
          /no such table|does not exist/,
        );
      });

      test("permissions revoked while awaiting a quote cannot freeze credits or admit a Turn", async (t) => {
        const f = await fixture(t, backend);
        const before = await f.counts();
        const account = await f.credits.getAccount(creditScope);
        for (const denied of [
          "extension:run",
          "thread:message:append",
          "run:create",
        ] as const) {
          const entered = deferred();
          const resume = deferred();
          t.after(() => resume.resolve());
          f.state.denied = null;
          f.quoteState.gate = resume.promise;
          f.quoteState.entered = () => entered.resolve();
          const deniedAdmission = assert.rejects(
            f.task.createTask(actor, command),
            /authorization_denied/,
          );
          await entered.promise;
          f.state.denied = denied;
          resume.resolve();
          await deniedAdmission;
          assert.deepEqual(await f.counts(), before);
          assert.deepEqual(await f.credits.getAccount(creditScope), account);
        }
        assert.equal(f.quoteState.calls.length, 3);
        assert.equal(await f.count("plugin_credit_reservations"), 0);
        assert.equal(await f.count("extension_credit_admissions"), 0);
        assert.equal(await f.count("plugin_credit_entries"), 1);
      });

      test("repeated credit migrations preserve core versions and accounting; a future link schema fails closed", async (t) => {
        const f = await fixture(t, backend);
        const saved = await f.task.createTask(actor, command);
        const account = await f.credits.getAccount(creditScope);
        const entries = await f.credits.listEntries({
          scope: creditScope,
          afterRevision: 0,
          limit: 100,
        });
        const before = await f.counts();
        const coreVersions =
          backend === "sqlite"
            ? "SELECT 'sqlite' AS component, user_version AS version FROM pragma_user_version"
            : `SELECT component, version FROM ${f.prefix}schema_migrations`;
        await f.sql(`CREATE TEMP TABLE credit_core_versions_before AS ${coreVersions};
          CREATE TEMP TABLE credit_migration_assertions (matches INTEGER NOT NULL CHECK(matches = 1));`);
        // Constraint failure makes any version difference a failing assertion on both databases.
        const assertVersions = async (linkVersion: number) =>
          f.sql(`
          INSERT INTO credit_migration_assertions SELECT CASE WHEN
            (SELECT version FROM ${f.prefix}extension_schema_version WHERE id = 1) = 1
            AND (SELECT version FROM ${f.prefix}plugin_credit_schema_version WHERE id = 1) = 1
            AND (SELECT version FROM ${f.prefix}extension_credit_schema_version WHERE id = 1) = ${linkVersion}
            AND NOT EXISTS (SELECT component, version FROM credit_core_versions_before EXCEPT ${coreVersions})
            AND NOT EXISTS (${coreVersions} EXCEPT SELECT component, version FROM credit_core_versions_before)
          THEN 1 ELSE 0 END;`);
        await f.first.store.migrateCredits();
        await f.second.store.migrateCredits();
        await assertVersions(1);
        assert.deepEqual(await f.credits.getAccount(creditScope), account);
        assert.deepEqual(
          await f.credits.listEntries({
            scope: creditScope,
            afterRevision: 0,
            limit: 100,
          }),
          entries,
        );
        assert.deepEqual(
          await f.first.store.loadExtensionCreditAdmission(saved.binding),
          saved.creditAdmission,
        );
        await f.sql(
          `UPDATE ${f.prefix}extension_credit_schema_version SET version = 99 WHERE id = 1;`,
        );
        await assert.rejects(
          f.first.store.migrateCredits(),
          /extension_credit_schema_version_unsupported/,
        );
        await assertVersions(99);
        assert.deepEqual(await f.counts(), before);
        assert.deepEqual(await f.credits.getAccount(creditScope), account);
        assert.deepEqual(
          await f.credits.listEntries({
            scope: creditScope,
            afterRevision: 0,
            limit: 100,
          }),
          entries,
        );
        assert.equal(await f.count("plugin_credit_reservations"), 1);
        assert.equal(await f.count("extension_credit_admissions"), 1);
        // Test cleanup only: migration must not have rewritten version 99 itself.
        await f.sql(
          `UPDATE ${f.prefix}extension_credit_schema_version SET version = 1 WHERE id = 1;`,
        );
        assert.deepEqual(
          await f.first.store.loadExtensionCreditAdmission(saved.binding),
          saved.creditAdmission,
        );
      });

      test("persisted generation credit links cannot be updated or deleted", async (t) => {
        const f = await fixture(t, backend);
        const saved = await f.task.createTask(actor, command);
        const account = await f.credits.getAccount(creditScope);
        for (const sql of [
          `UPDATE ${f.prefix}extension_credit_admissions SET admission_json = admission_json`,
          `DELETE FROM ${f.prefix}extension_credit_admissions`,
        ]) {
          await assert.rejects(
            f.sql(sql),
            /extension_credit_admission_immutable/,
          );
          assert.deepEqual(
            await f.first.store.loadExtensionCreditAdmission(saved.binding),
            saved.creditAdmission,
          );
        }
        assert.deepEqual(await f.credits.getAccount(creditScope), account);
        assert.equal(await f.count("extension_credit_admissions"), 1);
        assert.equal(await f.count("plugin_credit_reservations"), 1);
        assert.equal(await f.count("plugin_credit_entries"), 2);
      });

      test("a configured quote without explicit credit migration rejects instead of admitting a free task", async (t) => {
        const f = await fixture(t, backend, {
          schema: "absent",
          balance: null,
        });
        const before = await f.counts();
        await assert.rejects(
          f.task.createTask(actor, command),
          applicationFailure(
            "extension_service_unavailable",
            /plugin_credit_schema|extension_credit_schema|no such table|does not exist/,
          ),
        );
        assert.equal(f.quoteState.calls.length, 1);
        assert.deepEqual(await f.counts(), before);
        assert.equal(
          (await f.first.parent.loadThread({
            ...actor,
            threadId: command.threadId,
          }))!.revision,
          1,
        );
        await assert.rejects(
          f.count("plugin_credit_accounts"),
          /no such table|does not exist/,
        );
        await assert.rejects(
          f.count("extension_credit_admissions"),
          /no such table|does not exist/,
        );
      });
    },
  );
}
