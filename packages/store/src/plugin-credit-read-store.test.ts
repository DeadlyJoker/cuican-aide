import assert from "node:assert/strict";
import test from "node:test";
import type { PluginCreditAccountsReadResult } from "@crewon/application";
import type { CreditScope, CreditReservationInput } from "@crewon/domain";
import {
  creditReadFixture,
  creditReadAllRows,
} from "./plugin-credit-read.test-support.ts";

const scope: CreditScope = Object.freeze({
  tenantId: "named-read-tenant",
  principalId: "named-personal-user",
  poolId: "personal/插件/钱包",
});
const list = {
  tenantId: scope.tenantId,
  principalId: scope.principalId,
  afterPoolId: null,
  limit: 16,
};
const history = { scope, afterRevision: 0, limit: 50 };
const reservation: CreditReservationInput = {
  scope,
  reservationId: "named-read-generation",
  idempotencyKey: "named-read-request",
  requestDigest: `sha256:${"a".repeat(64)}`,
  pluginId: "crewon.comfyui-krea2",
  priceRevision: 1,
  quotedCredits: "30",
};

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend} readonly credits: unconfigured reads preserve objects and never migrate or fund`,
    options,
    async (t) => {
      const f = await creditReadFixture(t, backend),
        before = await f.catalog();
      const changes = backend === "sqlite" ? await f.changes() : null;
      assert.deepEqual(await f.first.listAccounts(list), {
        state: "unconfigured",
        accounts: [],
        nextPoolId: null,
      });
      assert.deepEqual(await f.first.readEntries(history), {
        state: "unconfigured",
        account: null,
        entries: [],
        nextRevision: null,
      });
      assert.deepEqual(await f.catalog(), before);
      if (backend === "sqlite") assert.equal(await f.changes(), changes);
      await f.first.migrate();
      const empty = await creditReadAllRows(f),
        migrated = await f.catalog();
      assert.deepEqual(await f.first.listAccounts(list), {
        state: "ready",
        accounts: [],
        nextPoolId: null,
      });
      assert.deepEqual(await f.first.readEntries(history), {
        state: "ready",
        account: null,
        entries: [],
        nextRevision: null,
      });
      assert.deepEqual(await creditReadAllRows(f), empty);
      assert.deepEqual(await f.catalog(), migrated);
    },
  );
  test(
    `${backend} readonly credits: pool keyset is bounded and binary for slash/unicode identities, with exact tenant and principal isolation`,
    options,
    async (t) => {
      const f = await creditReadFixture(t, backend);
      await f.first.migrate();
      const pools = [
        "a/one",
        "a/two",
        "z",
        "é",
        "插件/资金",
        "😀",
        "𐀀",
        ...Array.from(
          { length: 15 },
          (_, i) => `pool/${String(i).padStart(2, "0")}`,
        ),
      ];
      for (const poolId of pools)
        await f.writer.grant({
          scope: { ...scope, poolId },
          grantId: `named-${poolId}`,
          credits: "100",
        });
      await f.writer.grant({
        scope: { ...scope, tenantId: "other-tenant" },
        grantId: "other-tenant",
        credits: "200",
      });
      await f.writer.grant({
        scope: { ...scope, principalId: "other-user" },
        grantId: "other-user",
        credits: "300",
      });
      const before = await creditReadAllRows(f),
        expected = [...pools].sort((left, right) =>
          Buffer.compare(Buffer.from(left), Buffer.from(right)),
        );
      let afterPoolId: string | null = null;
      const observed: string[] = [];
      do {
        const page: PluginCreditAccountsReadResult = await f.first.listAccounts(
          {
            ...list,
            afterPoolId,
            limit: 3,
          },
        );
        assert.equal(page.state, "ready");
        assert.ok(page.accounts.length <= 3);
        assert.ok(Object.isFrozen(page.accounts));
        for (const account of page.accounts) {
          assert.equal(account.scope.tenantId, scope.tenantId);
          assert.equal(account.scope.principalId, scope.principalId);
          observed.push(account.scope.poolId);
        }
        afterPoolId = page.nextPoolId;
        if (afterPoolId !== null) {
          assert.equal(page.accounts.length, 3);
          assert.equal(afterPoolId, page.accounts.at(-1)!.scope.poolId);
        }
      } while (afterPoolId !== null);
      assert.deepEqual(observed, expected);
      assert.equal(
        (await f.first.listAccounts({ ...list, limit: 16 })).accounts.length,
        16,
      );
      assert.deepEqual(
        await f.first.listAccounts({ ...list, principalId: "no-user" }),
        { state: "ready", accounts: [], nextPoolId: null },
      );
      assert.deepEqual(await creditReadAllRows(f), before);
    },
  );
  test(
    `${backend} readonly credits: named grant/reserve/settle history has original balances and limit+1 cursors without mutation`,
    options,
    async (t) => {
      const f = await creditReadFixture(t, backend);
      await f.first.migrate();
      await f.writer.grant({
        scope,
        grantId: "named-test-funds",
        credits: "100",
      });
      await f.writer.reserve(reservation);
      await f.writer.settle({
        scope,
        reservationId: reservation.reservationId,
        actualCredits: "18",
      });
      const before = await creditReadAllRows(f),
        account = await f.writer.getAccount(scope);
      assert.deepEqual(
        account && [
          account.availableCredits,
          account.reservedCredits,
          account.spentCredits,
        ],
        ["82", "0", "18"],
      );
      const first = await f.first.readEntries({ ...history, limit: 2 });
      assert.deepEqual(first.account, account);
      assert.deepEqual(
        first.entries.map((entry) => [entry.revision, entry.kind]),
        [
          [2, "grant"],
          [3, "reserve"],
        ],
      );
      assert.equal(first.nextRevision, 3);
      const second = await f.first.readEntries({
        ...history,
        afterRevision: first.nextRevision!,
        limit: 2,
      });
      assert.deepEqual(second.account, account);
      assert.deepEqual(
        second.entries.map((entry) => [entry.revision, entry.kind]),
        [[4, "settle"]],
      );
      assert.equal(second.nextRevision, null);
      assert.deepEqual(
        await f.first.readEntries({ ...history, afterRevision: 4 }),
        { state: "ready", account, entries: [], nextRevision: null },
      );
      assert.deepEqual(
        await f.first.readEntries({
          ...history,
          scope: { ...scope, poolId: "not-created" },
        }),
        { state: "ready", account: null, entries: [], nextRevision: null },
      );
      assert.deepEqual(await creditReadAllRows(f), before);
    },
  );
  test(
    `${backend} readonly credits: concurrent writer between account and entries cannot tear the actual read snapshot`,
    options,
    async (t) => {
      const f = await creditReadFixture(t, backend);
      await f.first.migrate();
      const original = await f.writer.grant({
        scope,
        grantId: "original-named-funds",
        credits: "100",
      });
      const hook = await f.interceptAccountRead(() =>
        f.writer.grant({
          scope,
          grantId: "concurrent-named-funds",
          credits: "50",
        }),
      );
      let page;
      try {
        page = await f.first.readEntries(history);
      } finally {
        assert.equal(await hook.finish(), true);
      }
      assert.deepEqual(page.account, original);
      assert.deepEqual(
        page.entries.map((entry) => entry.revision),
        [2],
      );
      assert.deepEqual(page.entries[0]!.account, original);
      const current = await f.first.readEntries(history);
      assert.equal(current.account?.revision, 3);
      assert.deepEqual(
        current.entries.map((entry) => entry.revision),
        [2, 3],
      );
    },
  );
  test(
    `${backend} readonly credits: owner closure rejects both new and physically late reads`,
    options,
    async (t) => {
      const f = await creditReadFixture(t, backend);
      await f.first.migrate();
      await f.writer.grant({ scope, grantId: "named-funds", credits: "100" });
      const hook = await f.interceptAccountRead(async () => {
        f.closeHost();
      });
      try {
        await assert.rejects(
          f.first.readEntries(history),
          /credit_read_host_closed/,
        );
      } finally {
        await hook.finish();
      }
      await assert.rejects(
        f.first.listAccounts(list),
        /credit_read_host_closed/,
      );
      await assert.rejects(
        f.first.readEntries(history),
        /credit_read_host_closed/,
      );
    },
  );
  test(
    `${backend} readonly credits: invalid input/accessors are rejected without executing getters or creating a ledger`,
    options,
    async (t) => {
      const f = await creditReadFixture(t, backend),
        before = await f.catalog();
      let getters = 0;
      for (const limit of [0, 17, 1.5])
        await assert.rejects(
          f.first.listAccounts({ ...list, limit }),
          /plugin_credit_read_query_invalid/,
        );
      for (const limit of [0, 51, 1.5])
        await assert.rejects(
          f.first.readEntries({ ...history, limit }),
          /plugin_credit_read_query_invalid/,
        );
      for (const afterRevision of [-1, 0.5, 2_147_483_648])
        await assert.rejects(
          f.first.readEntries({ ...history, afterRevision }),
          /plugin_credit_read_query_invalid/,
        );
      await assert.rejects(
        f.first.listAccounts({
          ...list,
          get afterPoolId() {
            getters++;
            return null;
          },
        }),
        /plugin_credit_read_query_invalid/,
      );
      await assert.rejects(
        f.first.readEntries({
          ...history,
          scope: {
            ...scope,
            get poolId() {
              getters++;
              return scope.poolId;
            },
          },
        }),
        /plugin_credit_fields_invalid/,
      );
      assert.equal(getters, 0);
      assert.deepEqual(await f.catalog(), before);
    },
  );
  for (const defect of [
    "partial",
    "view",
    "columns",
    "marker",
    "account",
    "revision",
    "entry",
    "gap",
  ] as const)
    test(
      `${backend} readonly credits: ${defect} corruption fails closed rather than appearing unconfigured or empty`,
      options,
      async (t) => {
        const f = await creditReadFixture(t, backend);
        if (defect === "partial")
          await f.execute(
            `CREATE TABLE ${f.prefix}plugin_credit_schema_version(id INTEGER,version INTEGER)`,
          );
        else {
          await f.first.migrate();
          const account = await f.writer.grant({
            scope,
            grantId: "named-funds",
            credits: "100",
          });
          if (defect === "view" || defect === "columns") {
            await f.execute(
              `ALTER TABLE ${f.prefix}plugin_credit_grant_receipts RENAME TO original_grant_receipts`,
            );
            await f.execute(
              defect === "view"
                ? `CREATE VIEW ${f.prefix}plugin_credit_grant_receipts AS SELECT * FROM ${f.prefix}original_grant_receipts`
                : `CREATE TABLE ${f.prefix}plugin_credit_grant_receipts(tenant_id TEXT,principal_id TEXT,pool_id TEXT,grant_id TEXT,credits TEXT)`,
            );
          } else if (defect === "marker")
            await f.execute(
              `UPDATE ${f.prefix}plugin_credit_schema_version SET version=99`,
            );
          else if (defect === "account" || defect === "revision") {
            const corrupted =
              defect === "account"
                ? { ...account, scope: { ...scope, principalId: "other-user" } }
                : { ...account, revision: account.revision + 1 };
            await f.execute(
              `UPDATE ${f.prefix}plugin_credit_accounts SET account_json=${backend === "sqlite" ? "?" : "$1"}`,
              [JSON.stringify(corrupted)],
            );
          } else {
            if (backend === "sqlite") {
              await f.execute("DROP TRIGGER plugin_credit_entries_no_update");
              await f.execute("DROP TRIGGER plugin_credit_entries_no_delete");
            } else
              await f.execute(
                `DROP TRIGGER plugin_credit_entries_no_update_or_delete ON ${f.prefix}plugin_credit_entries`,
              );
            if (defect === "entry") {
              const row = (
                await f.rows(
                  `SELECT entry_json FROM ${f.prefix}plugin_credit_entries`,
                )
              )[0]!;
              const entry =
                typeof row.entry_json === "string"
                  ? JSON.parse(row.entry_json)
                  : row.entry_json;
              await f.execute(
                `UPDATE ${f.prefix}plugin_credit_entries SET entry_json=${backend === "sqlite" ? "?" : "$1"}`,
                [
                  JSON.stringify({
                    ...entry,
                    scope: { ...scope, principalId: "other-user" },
                  }),
                ],
              );
            } else
              await f.execute(`DELETE FROM ${f.prefix}plugin_credit_entries`);
          }
        }
        const before = await f.catalog();
        await assert.rejects(f.first.readEntries(history), /plugin_credit_/);
        if (!["entry", "gap"].includes(defect))
          await assert.rejects(f.first.listAccounts(list), /plugin_credit_/);
        assert.deepEqual(await f.catalog(), before);
      },
    );
}

test(
  "postgres readonly credits: an existing non-C pool collation remains readable with exact C keyset order and no read migration",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL },
  async (t) => {
    const f = await creditReadFixture(t, "postgres");
    await f.first.migrate();
    await f.execute(
      `CREATE COLLATION ${f.prefix}named_credit_non_c (provider=icu,locale='en-US',deterministic=true)`,
    );
    await f.execute(
      `ALTER TABLE ${f.prefix}plugin_credit_accounts ALTER COLUMN pool_id TYPE TEXT COLLATE ${f.prefix}named_credit_non_c USING pool_id::text`,
    );
    const pools = ["A", "Z", "a", "z", "é", "账户/积分"];
    for (const poolId of pools)
      await f.writer.grant({
        scope: { ...scope, poolId },
        grantId: `named-${poolId}`,
        credits: "10",
      });
    const before = await creditReadAllRows(f),
      catalog = await f.catalog(),
      expected = [...pools].sort((a, b) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b)),
      );
    const nativeOrder = (
      await f.rows(
        `SELECT pool_id FROM ${f.prefix}plugin_credit_accounts ORDER BY pool_id`,
      )
    ).map((row) => row.pool_id);
    assert.notDeepEqual(
      nativeOrder,
      expected,
      "the fixture's actual default pool ordering must differ from C",
    );
    const observed: string[] = [];
    let afterPoolId: string | null = null;
    do {
      const page: PluginCreditAccountsReadResult = await f.first.listAccounts({
        ...list,
        afterPoolId,
        limit: 2,
      });
      observed.push(...page.accounts.map((account) => account.scope.poolId));
      afterPoolId = page.nextPoolId;
    } while (afterPoolId !== null);
    assert.deepEqual(observed, expected);
    assert.equal(
      (
        await f.first.readEntries({
          ...history,
          scope: { ...scope, poolId: "é" },
        })
      ).account?.availableCredits,
      "10",
    );
    assert.deepEqual(await creditReadAllRows(f), before);
    assert.deepEqual(await f.catalog(), catalog);
  },
);

test("sqlite readonly credits: a temp same-name object cannot shadow an absent or configured original ledger", async (t) => {
  const f = await creditReadFixture(t, "sqlite");
  await f.execute(
    "CREATE TEMP VIEW plugin_credit_accounts AS SELECT 'pretend' AS account_json",
  );
  await assert.rejects(
    f.first.listAccounts(list),
    /plugin_credit_read_schema_invalid/,
  );
  await f.execute("DROP VIEW temp.plugin_credit_accounts");
  await f.first.migrate();
  await f.execute(
    "CREATE TEMP VIEW plugin_credit_accounts AS SELECT 'pretend' AS account_json",
  );
  await assert.rejects(
    f.first.readEntries(history),
    /plugin_credit_read_schema_invalid/,
  );
});
