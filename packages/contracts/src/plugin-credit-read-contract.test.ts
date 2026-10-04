import assert from "node:assert/strict";
import test from "node:test";
import { ContractValidationError } from "./contract-validation-error.ts";
import * as publicContracts from "./index.ts";
import {
  comparePluginCreditPoolIds,
  parsePluginCreditAccountView,
  parsePluginCreditAccountsQuery,
  parsePluginCreditAccountsResponse,
  parsePluginCreditEntriesQuery,
  parsePluginCreditEntriesResponse,
  parsePluginCreditEntryView,
  parsePluginCreditPoolId,
  pluginCreditAccountsPath,
  pluginCreditEntriesPath,
  validatePluginCreditAccountsQuery,
  validatePluginCreditEntriesQuery,
  type PluginCreditAccountView,
} from "./plugin-credit-read-contract.ts";

const poolId = "创作/个人 +pool";
const account: PluginCreditAccountView = {
  poolId,
  revision: 4,
  availableCredits: "82",
  reservedCredits: "0",
  spentCredits: "18",
  grantedCredits: "100",
};
const held = {
  ...account,
  revision: 3,
  availableCredits: "70",
  reservedCredits: "30",
  spentCredits: "0",
};
const grant = {
  ...account,
  revision: 2,
  availableCredits: "100",
  spentCredits: "0",
};
const entries = [
  { revision: 2, kind: "grant", credits: "100", account: grant },
  { revision: 3, kind: "reserve", credits: "30", account: held },
  { revision: 4, kind: "settle", credits: "18", account },
];
const accountsQuery = { afterPoolId: null, limit: 16 };
const entriesQuery = { poolId, afterRevision: 0, limit: 50 };
const accountResponse = {
  schemaVersion: "crewon.plugin-credit-accounts.v1",
  state: "ready",
  accounts: [account],
  nextPoolId: null,
};
const entryResponse = {
  schemaVersion: "crewon.plugin-credit-entries.v1",
  state: "ready",
  account,
  entries,
  nextRevision: null,
};
const rejects = (work: () => unknown) =>
  assert.throws(work, (error) => error instanceof ContractValidationError);

test("public read contracts expose the independent typed protocol without accounting commands", () => {
  assert.equal(
    publicContracts.parsePluginCreditAccountsQuery,
    parsePluginCreditAccountsQuery,
  );
  assert.equal(
    publicContracts.parsePluginCreditEntriesResponse,
    parsePluginCreditEntriesResponse,
  );
  assert.equal(
    publicContracts.PLUGIN_CREDIT_ACCOUNTS_PATH,
    "/api/v1/plugins/credits/accounts",
  );
  assert.equal(
    publicContracts.PLUGIN_CREDIT_ENTRIES_PATH,
    "/api/v1/plugins/credits/entries",
  );
});

test("HTTP queries default bounded pages and encode original opaque pool identities", () => {
  assert.deepEqual(parsePluginCreditAccountsQuery({}), accountsQuery);
  assert.deepEqual(parsePluginCreditEntriesQuery({ poolId }), entriesQuery);
  const path = pluginCreditEntriesPath({ poolId, afterRevision: 2, limit: 1 });
  const url = new URL(path, "https://app.invalid");
  assert.equal(url.pathname, "/api/v1/plugins/credits/entries");
  assert.equal(url.searchParams.get("poolId"), poolId);
  assert.deepEqual(
    parsePluginCreditEntriesQuery(Object.fromEntries(url.searchParams)),
    { poolId, afterRevision: 2, limit: 1 },
  );
  assert.deepEqual(
    parsePluginCreditAccountsQuery(
      Object.fromEntries(
        new URL(
          pluginCreditAccountsPath({ afterPoolId: poolId, limit: 16 }),
          "https://app.invalid",
        ).searchParams,
      ),
    ),
    { afterPoolId: poolId, limit: 16 },
  );
  assert.equal(parsePluginCreditPoolId("a/../%?#&中文"), "a/../%?#&中文");
});

test("query and normalized input reject injected authority, duplicates and coercion", () => {
  for (const value of [
    "0",
    "01",
    "17",
    1,
    ["1", "2"],
    "1e1",
    "1.0",
    " 1",
    null,
  ])
    rejects(() => parsePluginCreditAccountsQuery({ limit: value }));
  for (const value of ["0", "51", "050", 50, ["50"]])
    rejects(() => parsePluginCreditEntriesQuery({ poolId, limit: value }));
  for (const value of ["-1", "01", "2147483648", "1e2", 1, ["1"]])
    rejects(() =>
      parsePluginCreditEntriesQuery({ poolId, afterRevision: value }),
    );
  for (const key of [
    "principalId",
    "tenantId",
    "actorId",
    "scope",
    "grantId",
    "credits",
  ])
    rejects(() => parsePluginCreditEntriesQuery({ poolId, [key]: "forged" }));
  rejects(() => parsePluginCreditAccountsQuery({ afterPoolId: null }));
  rejects(() =>
    validatePluginCreditAccountsQuery({ afterPoolId: null, limit: 17 }),
  );
  rejects(() =>
    validatePluginCreditEntriesQuery({ poolId, afterRevision: -1, limit: 50 }),
  );
  assert.deepEqual(
    parsePluginCreditEntriesQuery({
      poolId,
      afterRevision: "2147483647",
      limit: "50",
    }),
    { poolId, afterRevision: 2147483647, limit: 50 },
  );
});

test("IDs retain domain limits and pagination follows UTF-8 BINARY/C order", () => {
  assert.equal(parsePluginCreditPoolId("😀".repeat(64)), "😀".repeat(64));
  for (const value of [
    "",
    " ",
    " id",
    "id ",
    "x".repeat(129),
    "a\0b",
    "a\ud800b",
    {},
    1,
  ])
    rejects(() => parsePluginCreditPoolId(value));
  assert.ok(comparePluginCreditPoolIds("\ue000", "𐀀") < 0);
  const page = {
    ...accountResponse,
    accounts: [
      { ...account, poolId: "\ue000" },
      { ...account, poolId: "𐀀" },
    ],
  };
  assert.deepEqual(
    parsePluginCreditAccountsResponse(page, accountsQuery).accounts.map(
      (x) => x.poolId,
    ),
    ["\ue000", "𐀀"],
  );
  rejects(() =>
    parsePluginCreditAccountsResponse(
      { ...page, accounts: [...page.accounts].reverse() },
      accountsQuery,
    ),
  );
});

test("decimal strings preserve amounts beyond Number precision and enforce conservation", () => {
  const huge = "999999999999999999999999999999999999999999999999";
  const view = {
    ...account,
    availableCredits: (BigInt(huge) - 18n).toString(),
    grantedCredits: huge,
  };
  assert.deepEqual(parsePluginCreditAccountView(view), view);
  for (const value of [
    0,
    -1,
    "-0",
    "00",
    "+1",
    "1e3",
    "1.5",
    "1".repeat(49),
    null,
  ])
    rejects(() =>
      parsePluginCreditAccountView({ ...account, grantedCredits: value }),
    );
  rejects(() =>
    parsePluginCreditAccountView({ ...account, availableCredits: "83" }),
  );
  for (const revision of [0, 1.5, "4", 2147483648])
    rejects(() => parsePluginCreditAccountView({ ...account, revision }));
});

test("account pages enforce actual identity order and exact continuation bounds", () => {
  const query = { afterPoolId: "a", limit: 1 };
  assert.equal(
    parsePluginCreditAccountsResponse(
      {
        ...accountResponse,
        accounts: [{ ...account, poolId: "b" }],
        nextPoolId: "b",
      },
      query,
    ).nextPoolId,
    "b",
  );
  for (const response of [
    { ...accountResponse, accounts: [], nextPoolId: "b" },
    { ...accountResponse, accounts: [{ ...account, poolId: "a" }] },
    { ...accountResponse, accounts: [account, account] },
    { ...accountResponse, nextPoolId: "different" },
  ])
    rejects(() => parsePluginCreditAccountsResponse(response, query));
  assert.equal(
    parsePluginCreditAccountsResponse(
      { ...accountResponse, accounts: [{ ...account, poolId: "b" }] },
      query,
    ).nextPoolId,
    null,
  );
});

test("historical entries preserve balance-after snapshots distinct from the current account", () => {
  const parsed = parsePluginCreditEntriesResponse(entryResponse, entriesQuery);
  assert.equal(parsed.account!.availableCredits, "82");
  assert.equal(parsed.entries[1]!.account.availableCredits, "70");
  assert.equal(parsed.entries[1]!.account.reservedCredits, "30");
  assert.ok(
    Object.isFrozen(parsed) &&
      Object.isFrozen(parsed.entries) &&
      Object.isFrozen(parsed.entries[0]!.account),
  );
  assert.equal(
    parsePluginCreditEntriesResponse(
      { ...entryResponse, entries: entries.slice(0, 1), nextRevision: 2 },
      { ...entriesQuery, limit: 1 },
    ).nextRevision,
    2,
  );
});

test("entry pages reject wrong pools, late revisions, mismatched latest balance and cursor lies", () => {
  for (const response of [
    { ...entryResponse, account: { ...account, poolId: "other" } },
    {
      ...entryResponse,
      entries: [{ ...entries[0], account: { ...grant, poolId: "other" } }],
    },
    { ...entryResponse, entries: [...entries].reverse() },
    { ...entryResponse, entries: [entries[0], entries[0]] },
    {
      ...entryResponse,
      entries: [
        { ...entries[2], revision: 5, account: { ...account, revision: 5 } },
      ],
    },
    {
      ...entryResponse,
      entries: [
        {
          ...entries[2],
          account: { ...account, availableCredits: "81", spentCredits: "19" },
        },
      ],
    },
    { ...entryResponse, nextRevision: 4 },
    { ...entryResponse, entries: entries.slice(0, 1), nextRevision: 3 },
    { ...entryResponse, account: null, entries: [] },
  ])
    rejects(() => parsePluginCreditEntriesResponse(response, entriesQuery));
  rejects(() =>
    parsePluginCreditEntriesResponse(entryResponse, {
      ...entriesQuery,
      afterRevision: 2,
    }),
  );
  assert.deepEqual(
    parsePluginCreditEntriesResponse(
      { ...entryResponse, entries: [] },
      { ...entriesQuery, afterRevision: 4 },
    ).entries,
    [],
  );
});

test("unconfigured responses carry no fake balance, records, or continuation", () => {
  const emptyAccounts = {
    ...accountResponse,
    state: "unconfigured",
    accounts: [],
  };
  const emptyEntries = {
    ...entryResponse,
    state: "unconfigured",
    account: null,
    entries: [],
  };
  assert.equal(
    parsePluginCreditAccountsResponse(emptyAccounts, accountsQuery).state,
    "unconfigured",
  );
  assert.equal(
    parsePluginCreditEntriesResponse(emptyEntries, entriesQuery).account,
    null,
  );
  for (const value of [
    accountResponse,
    { ...emptyAccounts, nextPoolId: poolId },
  ])
    rejects(() =>
      parsePluginCreditAccountsResponse(
        { ...value, state: "unconfigured" },
        accountsQuery,
      ),
    );
  for (const value of [entryResponse, { ...emptyEntries, nextRevision: 1 }])
    rejects(() =>
      parsePluginCreditEntriesResponse(
        { ...value, state: "unconfigured" },
        entriesQuery,
      ),
    );
  rejects(() =>
    parsePluginCreditAccountsResponse(
      { ...emptyAccounts, schemaVersion: "crewon.plugin-credit-accounts.v2" },
      accountsQuery,
    ),
  );
});

test("strict views do not expose private payer, grant, reservation or fabricated time fields", () => {
  for (const key of [
    "tenantId",
    "principalId",
    "scope",
    "currency",
    "priceRevision",
  ])
    rejects(() =>
      parsePluginCreditAccountView({ ...account, [key]: "private" }),
    );
  for (const key of [
    "grantId",
    "reservationId",
    "createdAt",
    "tenantId",
    "principalId",
  ])
    rejects(() =>
      parsePluginCreditEntryView({ ...entries[0], [key]: "private" }),
    );
  rejects(() => parsePluginCreditEntryView({ ...entries[0], revision: 3 }));
  rejects(() => parsePluginCreditEntryView({ ...entries[0], credits: "0" }));
  assert.equal(
    parsePluginCreditEntryView({ ...entries[2], credits: "0" }).credits,
    "0",
  );
});

test("validation never invokes accessors, toJSON, or kind coercion hooks", () => {
  let invoked = 0;
  const getter = Object.defineProperty({}, "poolId", {
    enumerable: true,
    get() {
      invoked++;
      return poolId;
    },
  });
  rejects(() => parsePluginCreditEntriesQuery(getter));
  rejects(() =>
    parsePluginCreditAccountView({
      ...account,
      toJSON() {
        invoked++;
        return account;
      },
    }),
  );
  rejects(() =>
    parsePluginCreditEntryView({
      ...entries[0],
      kind: {
        toString() {
          invoked++;
          return "grant";
        },
      },
    }),
  );
  const page = [account];
  Object.defineProperty(page, "0", {
    enumerable: true,
    get() {
      invoked++;
      return account;
    },
  });
  rejects(() =>
    parsePluginCreditAccountsResponse(
      { ...accountResponse, accounts: page },
      accountsQuery,
    ),
  );
  rejects(() =>
    parsePluginCreditAccountsResponse(
      { ...accountResponse, accounts: new Array(1) },
      accountsQuery,
    ),
  );
  rejects(() =>
    parsePluginCreditAccountsResponse(
      { ...accountResponse, [Symbol("authority")]: "private" },
      accountsQuery,
    ),
  );
  assert.equal(invoked, 0);
});
