import assert from "node:assert/strict";
import test from "node:test";
import {
  ApplicationError,
  type ActorContext,
  type AuthorizationDecision,
  type PluginCreditReadAuthorizationPort,
  type PluginCreditReadAuthorizationRequest,
  type PluginCreditReadStore,
} from "@crewon/application";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import type { CreditAccount } from "@crewon/domain";
import { PostgresDomainStore } from "@crewon/store";
import { composePluginCreditReads } from "./plugin-credit-read-composition.ts";
import {
  createProductionPostgresControlApi,
  type ProductionPostgresControlApiConfig,
} from "./production-composition.ts";
import { validateProductionConfig } from "./production-configuration-validation.ts";
import {
  DynamicPolicyAuthorization,
  type PolicyDecisionPort,
} from "./production-security-adapters.ts";
import { StandaloneAuthorization } from "./standalone-adapters.ts";

const ACTOR: ActorContext = Object.freeze({
  principalId: "named-credit-reader",
  actorId: "named-authenticated-actor",
  tenantId: "named-tenant",
  spaceId: "named-space",
});
const POOL = "named-personal-pool/专业能力";
const LIST_QUERY = Object.freeze({ afterPoolId: null, limit: 16 });
const ENTRIES_QUERY = Object.freeze({
  poolId: POOL,
  afterRevision: 0,
  limit: 50,
});

function permission(
  poolId: string | null = null,
): PluginCreditReadAuthorizationRequest {
  return {
    actor: ACTOR,
    action: "pluginCredit:read",
    resource: {
      kind: "pluginCredit",
      tenantId: ACTOR.tenantId,
      spaceId: ACTOR.spaceId,
      principalId: ACTOR.principalId,
      poolId,
    },
  };
}
function hasApplicationError(
  category: ApplicationError["category"],
  code: string,
) {
  return (error: unknown) =>
    error instanceof ApplicationError &&
    error.category === category &&
    error.code === code;
}

/** Named immutable ledger projection only; this fixture neither grants nor prices credits. */
class ReadStore implements PluginCreditReadStore {
  readonly account: CreditAccount = Object.freeze({
    schemaVersion: "crewon.plugin-credit-account.v0",
    scope: Object.freeze({
      tenantId: ACTOR.tenantId,
      principalId: ACTOR.principalId,
      poolId: POOL,
    }),
    revision: 3,
    availableCredits: "82",
    reservedCredits: "0",
    spentCredits: "18",
    grantedCredits: "100",
  });
  readonly lists: Parameters<PluginCreditReadStore["listAccounts"]>[0][] = [];
  readonly entries: Parameters<PluginCreditReadStore["readEntries"]>[0][] = [];
  migrations = 0;
  mutations = 0;
  beforeListResult: (() => void) | null = null;
  async listAccounts(
    input: Parameters<PluginCreditReadStore["listAccounts"]>[0],
  ) {
    this.lists.push(input);
    this.beforeListResult?.();
    return {
      state: "ready" as const,
      accounts: [this.account],
      nextPoolId: null,
    };
  }
  async readEntries(
    input: Parameters<PluginCreditReadStore["readEntries"]>[0],
  ) {
    this.entries.push(input);
    return {
      state: "ready" as const,
      account: this.account,
      entries: [],
      nextRevision: null,
    };
  }
  async migrate() {
    this.migrations++;
  }
  async grant() {
    this.mutations++;
    throw new Error("read_path_must_not_fund");
  }
}

test("personal credit policy forwards the original action, authenticated actor and self resource to the original PDP", async () => {
  const calls: Parameters<PolicyDecisionPort["decide"]>[0][] = [];
  const authorization: PluginCreditReadAuthorizationPort =
    new DynamicPolicyAuthorization({
      timeoutMs: 2_000,
      policy: {
        async decide(input) {
          calls.push(input);
          return { outcome: "allow" };
        },
      },
    });
  for (const poolId of [null, POOL]) {
    const request = permission(poolId);
    assert.deepEqual(await authorization.authorize(request), {
      outcome: "allow",
    });
    const actual = calls.at(-1)!;
    const { signal, ...body } = actual;
    assert.deepEqual(body, request);
    assert.equal(actual.actor, ACTOR);
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
  }
  assert.equal(calls.length, 2);
});

test("personal credit tenant, space and principal mismatches deny before any PDP invocation", async () => {
  let calls = 0;
  const authorization = new DynamicPolicyAuthorization({
    timeoutMs: 2_000,
    policy: {
      async decide() {
        calls++;
        return { outcome: "allow" };
      },
    },
  });
  const request = permission(POOL);
  for (const field of ["tenantId", "spaceId", "principalId"] as const) {
    assert.deepEqual(
      await authorization.authorize({
        ...request,
        resource: { ...request.resource, [field]: "foreign-scope" },
      }),
      { outcome: "deny", reasonCode: "actor_scope_mismatch" },
    );
    assert.deepEqual(
      await authorization.authorize({
        ...request,
        actor: { ...ACTOR, [field]: "foreign-actor-scope" },
      }),
      { outcome: "deny", reasonCode: "actor_scope_mismatch" },
    );
  }
  assert.equal(calls, 0);
});

test("personal credit policy is reevaluated after withdrawal rather than caching installation or an earlier read permission", async () => {
  let response: AuthorizationDecision = { outcome: "allow" };
  const calls: Parameters<PolicyDecisionPort["decide"]>[0][] = [];
  const authorization = new DynamicPolicyAuthorization({
    timeoutMs: 2_000,
    policy: {
      async decide(input) {
        calls.push(input);
        return response;
      },
    },
  });
  const request = permission(POOL);
  assert.deepEqual(await authorization.authorize(request), {
    outcome: "allow",
  });
  response = { outcome: "deny", reasonCode: "personal_credit_read_withdrawn" };
  assert.deepEqual(await authorization.authorize(request), response);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0]?.signal, calls[1]?.signal);
});

test("policy transport failure and malformed decisions never fall back to personal credit read permission", async () => {
  const replies: unknown[] = [
    null,
    { outcome: "allow", cached: true },
    { outcome: "deny" },
    { outcome: "deny", reasonCode: "bad reason with spaces" },
    { outcome: "unknown" },
  ];
  for (const reply of replies) {
    const store = new ReadStore();
    const service = composePluginCreditReads(
      store,
      new DynamicPolicyAuthorization({
        timeoutMs: 2_000,
        policy: {
          async decide() {
            return reply;
          },
        },
      }),
    );
    await assert.rejects(
      service.listAccounts(ACTOR, LIST_QUERY),
      hasApplicationError(
        "internal",
        "plugin_credit_read_authorization_unavailable",
      ),
    );
    assert.equal(store.lists.length, 0);
    assert.equal(store.entries.length, 0);
  }
  const store = new ReadStore();
  const service = composePluginCreditReads(
    store,
    new DynamicPolicyAuthorization({
      timeoutMs: 2_000,
      policy: {
        async decide() {
          throw new Error("named_policy_transport_failure");
        },
      },
    }),
  );
  await assert.rejects(
    service.getEntries(ACTOR, ENTRIES_QUERY),
    hasApplicationError(
      "internal",
      "plugin_credit_read_authorization_unavailable",
    ),
  );
  assert.equal(store.entries.length, 0);
  assert.equal(store.migrations, 0);
  assert.equal(store.mutations, 0);
});

test("a real PDP deadline aborts its in-flight request and returns no personal ledger data", async () => {
  const store = new ReadStore();
  let authoritySignal: AbortSignal | undefined;
  const service = composePluginCreditReads(
    store,
    new DynamicPolicyAuthorization({
      timeoutMs: 5,
      policy: {
        async decide(input) {
          authoritySignal = input.signal;
          return new Promise(() => {});
        },
      },
    }),
  );
  await assert.rejects(
    service.listAccounts(ACTOR, LIST_QUERY),
    hasApplicationError(
      "internal",
      "plugin_credit_read_authorization_unavailable",
    ),
  );
  assert.equal(authoritySignal?.aborted, true);
  assert.equal(store.lists.length, 0);
});

test("standalone personal reads require the exact trusted fixed actor and its own principal, tenant and space", async () => {
  const authorization: PluginCreditReadAuthorizationPort =
    new StandaloneAuthorization(ACTOR);
  const request = permission(POOL);
  assert.deepEqual(await authorization.authorize(request), {
    outcome: "allow",
  });
  assert.deepEqual(await authorization.authorize(permission()), {
    outcome: "allow",
  });
  for (const field of [
    "principalId",
    "actorId",
    "tenantId",
    "spaceId",
  ] as const) {
    assert.deepEqual(
      await authorization.authorize({
        ...request,
        actor: { ...ACTOR, [field]: "another-actor" },
      }),
      { outcome: "deny", reasonCode: "standalone_scope_mismatch" },
    );
  }
  for (const field of ["principalId", "tenantId", "spaceId"] as const) {
    assert.deepEqual(
      await authorization.authorize({
        ...request,
        resource: { ...request.resource, [field]: "another-resource" },
      }),
      { outcome: "deny", reasonCode: "standalone_scope_mismatch" },
    );
  }
});

test("standalone authorization detaches the fixed trusted actor from a later caller mutation", async () => {
  const supplied = { ...ACTOR };
  const authorization = new StandaloneAuthorization(supplied);
  supplied.principalId = "mutated-principal";
  assert.deepEqual(await authorization.authorize(permission(POOL)), {
    outcome: "allow",
  });
  assert.deepEqual(
    await authorization.authorize({
      ...permission(POOL),
      actor: supplied,
      resource: {
        ...permission(POOL).resource,
        principalId: supplied.principalId,
      },
    }),
    { outcome: "deny", reasonCode: "standalone_scope_mismatch" },
  );
});

test("an omitted new personal credit authority denies list and entries without any ledger read, migration or funding", async () => {
  const store = new ReadStore();
  const service = composePluginCreditReads(store);
  await assert.rejects(
    service.listAccounts(ACTOR, LIST_QUERY),
    hasApplicationError("authorization", "plugin_credit_read_forbidden"),
  );
  await assert.rejects(
    service.getEntries(ACTOR, ENTRIES_QUERY),
    hasApplicationError("authorization", "plugin_credit_read_forbidden"),
  );
  assert.equal(store.lists.length, 0);
  assert.equal(store.entries.length, 0);
  assert.equal(store.migrations, 0);
  assert.equal(store.mutations, 0);
});

test("explicit personal read authority performs only bounded self ledger reads and never migrates or funds", async () => {
  const store = new ReadStore();
  const requests: PluginCreditReadAuthorizationRequest[] = [];
  const authorization: PluginCreditReadAuthorizationPort = {
    async authorize(request) {
      requests.push(request);
      return { outcome: "allow" };
    },
  };
  const service = composePluginCreditReads(store, authorization);
  const listed = await service.listAccounts(ACTOR, LIST_QUERY);
  const history = await service.getEntries(ACTOR, ENTRIES_QUERY);
  assert.deepEqual(listed, {
    state: "ready",
    accounts: [store.account],
    nextPoolId: null,
  });
  assert.deepEqual(history, {
    state: "ready",
    account: store.account,
    entries: [],
    nextRevision: null,
  });
  assert.deepEqual(store.lists, [
    {
      tenantId: ACTOR.tenantId,
      principalId: ACTOR.principalId,
      afterPoolId: null,
      limit: 16,
    },
  ]);
  assert.deepEqual(store.entries, [
    { scope: store.account.scope, afterRevision: 0, limit: 50 },
  ]);
  assert.deepEqual(requests, [
    permission(),
    permission(),
    permission(POOL),
    permission(POOL),
  ]);
  assert.equal(store.migrations, 0);
  assert.equal(store.mutations, 0);
});

test("withdrawal during a ledger read forces a fresh PDP decision before any response is released", async () => {
  const store = new ReadStore();
  let allowed = true;
  let decisions = 0;
  store.beforeListResult = () => {
    allowed = false;
  };
  const service = composePluginCreditReads(
    store,
    new DynamicPolicyAuthorization({
      timeoutMs: 2_000,
      policy: {
        async decide() {
          decisions++;
          return allowed
            ? { outcome: "allow" }
            : { outcome: "deny", reasonCode: "credit_read_withdrawn" };
        },
      },
    }),
  );
  await assert.rejects(
    service.listAccounts(ACTOR, LIST_QUERY),
    hasApplicationError("authorization", "plugin_credit_read_forbidden"),
  );
  assert.equal(decisions, 2);
  assert.equal(store.lists.length, 1);
  await assert.rejects(
    service.listAccounts(ACTOR, LIST_QUERY),
    hasApplicationError("authorization", "plugin_credit_read_forbidden"),
  );
  assert.equal(decisions, 3);
  assert.equal(store.lists.length, 1);
});

// This compile-time assignment preserves the original production configuration
// shape without inventing a credit authority or opening a test database.
function oldProductionConfig(): ProductionPostgresControlApiConfig {
  return {
    connectionString: "named-unused-database-fixture",
    identity: {
      async resolveActor() {
        return ACTOR;
      },
    },
    authorization: {
      async authorize() {
        return { outcome: "allow" };
      },
    },
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "named-existing-artifact-key",
  };
}

test("the original typed production configuration still passes preflight without the additive credit-read authority", async (t) => {
  const config = oldProductionConfig();
  t.after(() => config.artifactStore.close());
  assert.equal(Object.hasOwn(config, "pluginCreditAuthorization"), false);
  assert.doesNotThrow(() => validateProductionConfig(config));
  let attemptedDatabaseOpen = 0;
  t.mock.method(PostgresDomainStore, "open", async () => {
    attemptedDatabaseOpen++;
    throw new Error("named_test_stops_at_original_database_open");
  });
  await assert.rejects(
    createProductionPostgresControlApi(config),
    /named_test_stops_at_original_database_open/u,
  );
  assert.equal(attemptedDatabaseOpen, 1);
});

test("an explicitly malformed new production credit authority is rejected before the database opens", async (t) => {
  const config = oldProductionConfig();
  t.after(() => config.artifactStore.close());
  let attemptedDatabaseOpen = 0;
  t.mock.method(PostgresDomainStore, "open", async () => {
    attemptedDatabaseOpen++;
    throw new Error("must_not_open_database");
  });
  for (const malformed of [
    null,
    {},
    { authorize: undefined },
    { authorize: "not-a-function" },
  ]) {
    await assert.rejects(
      createProductionPostgresControlApi({
        ...config,
        pluginCreditAuthorization:
          malformed as unknown as PluginCreditReadAuthorizationPort,
      }),
      /production_plugin_credit_authorization_required/u,
    );
  }
  assert.equal(attemptedDatabaseOpen, 0);
});
