import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  PimControlSessions,
  pimControlAccountActor,
  type PimPluginProfilePort,
} from "./pim-control-sessions.ts";
import type { PimAccountScope } from "./pim-account-authority.ts";

function fixture(
  capacity = 1000,
  packages: ConstructorParameters<
    typeof PimControlSessions
  >[0]["packages"] = new Map([
    ["crewon.short-drama", `sha256:${"a".repeat(64)}`],
  ]),
) {
  let now = Date.parse("2026-10-13T00:00:00Z");
  const account: {
    -readonly [K in keyof PimAccountScope]: PimAccountScope[K];
  } = {
    userId: 12,
    tenantId: 8,
    spaceId: 9,
    userRole: "user",
    tenantRole: "member",
    spaceRole: "member",
    expiresAt: now + 3600000,
  };
  // Named in-memory authority fixture; production storage is tested with real PostgreSQL separately.
  const profiles = new Map<
    string,
    Awaited<ReturnType<PimPluginProfilePort["resolveVerifiedAccount"]>>
  >();
  let rejectAccount = false;
  const sessions = new PimControlSessions({
    issuer: "https://crewon.example/identity/pim",
    capacity,
    now: () => now,
    packages,
    accounts: {
      verify: async (token, signal) => {
        signal.throwIfAborted();
        if (rejectAccount) throw new Error("pim_account_denied");
        return { ...account, userId: token === "other-account" ? 13 : 12 };
      },
    },
    profiles: {
      resolveVerifiedAccount: async ({ actor, membershipDigest }) => {
        const key = JSON.stringify(actor);
        const before = profiles.get(key);
        const current = {
          scope: before?.scope ?? {
            tenantId: actor.tenantId,
            spaceId: actor.spaceId,
            profileId: randomUUID(),
          },
          authorityEpoch:
            before?.membershipDigest === membershipDigest
              ? before.authorityEpoch
              : randomUUID(),
          membershipDigest,
          revoked: before?.revoked ?? false,
        };
        profiles.set(key, current);
        return current;
      },
    },
  });
  return {
    sessions,
    account,
    profiles,
    setTime: (t: number) => {
      now = t;
    },
    getTime: () => now,
    denyAccount: () => {
      rejectAccount = true;
    },
  };
}
const signal = () => new AbortController().signal;
test("exchanges the existing account for an opaque Control credential and secure host cookie", async () => {
  const { sessions, account } = fixture();
  const created = await sessions.exchange("original-pim-token", signal());
  assert.match(
    created.setCookie,
    /; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=480$/,
  );
  assert.doesNotMatch(created.session.controlAccessToken, /original-pim-token/);
  assert.deepEqual(
    await sessions.resolve({
      cookie: created.setCookie.split(";")[0]!,
      userAgent: null,
      pimAccessToken: "original-pim-token",
    }),
    created.session,
  );
  assert.equal(
    await sessions.resolve({
      cookie: created.setCookie.split(";")[0]!,
      userAgent: null,
      pimAccessToken: "other-account",
    }),
    null,
  );
  assert.equal(
    await sessions.resolve({
      cookie: created.setCookie.split(";")[0]!,
      userAgent: null,
    }),
    null,
  );
  const assertion = await sessions.verifyControlToken(
    created.session.controlAccessToken,
    signal(),
  );
  assert.deepEqual(
    { ...assertion, issuedAt: undefined, expiresAt: undefined },
    {
      issuer: "https://crewon.example/identity/pim",
      audience: "crewon-control",
      ...pimControlAccountActor(account),
      issuedAt: undefined,
      expiresAt: undefined,
    },
  );
  await assert.rejects(
    sessions.verifyControlToken("original-pim-token", signal()),
    /session_required/,
  );
});
test("profiles and plugin policy isolate accounts, reject unapproved packages and unknown actions", async () => {
  const { sessions, account } = fixture();
  await sessions.exchange("account", signal());
  await sessions.exchange("other-account", signal());
  const actor = pimControlAccountActor(account);
  const own = await sessions.pluginProfile(actor, signal());
  const other = await sessions.pluginProfile(
    { ...actor, actorId: "pim-user-13", principalId: "pim-user-13" },
    signal(),
  );
  assert.notEqual(own.profileId, other.profileId);
  const request = {
    actor,
    action: "pluginInstallation:install",
    resource: {
      kind: "pluginInstallation",
      ...own,
      pluginId: "crewon.short-drama",
      packageDigest: `sha256:${"a".repeat(64)}`,
    },
  };
  assert.equal(
    (await sessions.pluginPolicy(request, signal())).outcome,
    "allow",
  );
  for (const modified of [
    { ...request, action: "unknown" },
    {
      ...request,
      resource: { ...request.resource, profileId: other.profileId },
    },
    {
      ...request,
      resource: {
        ...request.resource,
        packageDigest: `sha256:${"b".repeat(64)}`,
      },
    },
    { ...request, resource: { ...request.resource, pluginId: "unapproved" } },
  ])
    assert.equal(
      (await sessions.pluginPolicy(modified, signal())).outcome,
      "deny",
    );
});
test("upgrading permits both explicitly approved versions without admitting another digest or retaining caller mutations", async () => {
  const digests = [`sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`];
  const { sessions, account } = fixture(
    1000,
    new Map([["crewon.short-drama", digests]]),
  );
  digests.push(`sha256:${"c".repeat(64)}`);
  await sessions.exchange("account", signal());
  const actor = pimControlAccountActor(account),
    profile = await sessions.pluginProfile(actor, signal());
  for (const [packageDigest, outcome] of [
    [digests[0], "allow"],
    [digests[1], "allow"],
    [digests[2], "deny"],
  ]) {
    const decision = await sessions.pluginPolicy(
      {
        actor,
        action: "pluginInstallation:install",
        resource: {
          kind: "pluginInstallation",
          ...profile,
          pluginId: "crewon.short-drama",
          packageDigest,
        },
      },
      signal(),
    );
    assert.equal(decision.outcome, outcome);
  }
});
test("live account rejection and durable profile revocation fail closed", async () => {
  const { sessions, account, profiles, denyAccount } = fixture();
  const created = await sessions.exchange("account", signal());
  const actor = pimControlAccountActor(account);
  const key = JSON.stringify(actor);
  profiles.set(key, { ...profiles.get(key)!, revoked: true });
  await assert.rejects(
    sessions.verifyControlToken(created.session.controlAccessToken, signal()),
    /profile_denied/,
  );
  denyAccount();
  await assert.rejects(
    sessions.pluginProfile(actor, signal()),
    /account_denied/,
  );
});
test("membership changes move the epoch and viewer permissions never authorize mutation", async () => {
  const { sessions, account } = fixture();
  await sessions.exchange("account", signal());
  const actor = pimControlAccountActor(account);
  const scope = await sessions.pluginProfile(actor, signal());
  const resource = {
    kind: "pluginUi",
    ...scope,
    pluginId: "crewon.short-drama",
    packageDigest: `sha256:${"a".repeat(64)}`,
  };
  const before = await sessions.pluginPolicy(
    { actor, action: "pluginUi:catalog", resource },
    signal(),
  );
  account.spaceRole = "viewer";
  const after = await sessions.pluginPolicy(
    { actor, action: "pluginUi:catalog", resource },
    signal(),
  );
  assert.equal(before.outcome, "allow");
  assert.equal(after.outcome, "allow");
  if (before.outcome === "allow" && after.outcome === "allow")
    assert.notEqual(before.authorityEpoch, after.authorityEpoch);
  assert.equal(
    (
      await sessions.pluginPolicy(
        { actor, action: "pluginUi:invoke", resource },
        signal(),
      )
    ).outcome,
    "deny",
  );
});
test("bounds session capacity, expires credentials and rejects duplicate cookies", async () => {
  const { sessions, setTime, getTime } = fixture(1);
  const created = await sessions.exchange("account", signal());
  await assert.rejects(
    sessions.exchange("other-account", signal()),
    /capacity_exceeded/,
  );
  const cookie = created.setCookie.split(";")[0]!;
  assert.equal(
    await sessions.resolve({ cookie: `${cookie};${cookie}`, userAgent: null }),
    null,
  );
  sessions.revokeCookie(cookie);
  await assert.rejects(
    sessions.verifyControlToken(created.session.controlAccessToken, signal()),
    /session_required/,
  );
  const next = await sessions.exchange("account", signal());
  setTime(getTime() + 480000);
  await assert.rejects(
    sessions.verifyControlToken(next.session.controlAccessToken, signal()),
    /session_required/,
  );
});
test("tabs sharing the same verified account reuse one Cookie without extending its lifetime", async () => {
  const f = fixture(1);
  const [a, b] = await Promise.all([
    f.sessions.exchange("account", signal()),
    f.sessions.exchange("account", signal()),
  ]);
  assert.equal(a.session.sessionId, b.session.sessionId);
  assert.equal(a.session.controlAccessToken, b.session.controlAccessToken);
  f.setTime(f.getTime() + 60000);
  const c = await f.sessions.exchange("account", signal());
  assert.equal(c.session.expiresAt, a.session.expiresAt);
  assert.match(c.setCookie, /Max-Age=420(?:;|$)/);
  f.denyAccount();
  await assert.rejects(
    f.sessions.exchange("account", signal()),
    /pim_account_denied/,
  );
});

test("public module imports revalidate account and profile, and never extend expired or revoked sessions", async () => {
  const f = fixture();
  const created = await f.sessions.exchange("account", signal());
  const input = { cookie: created.setCookie.split(";")[0]!, signal: signal() };
  assert.deepEqual(
    await f.sessions.resolvePublicPluginAsset(input),
    created.session,
  );
  assert.equal(
    await f.sessions.resolve({ cookie: input.cookie, userAgent: null }),
    null,
  );
  f.denyAccount();
  await assert.rejects(
    f.sessions.resolvePublicPluginAsset(input),
    /pim_account_denied/,
  );
  f.setTime(Date.parse(created.session.expiresAt) + 1);
  assert.equal(await f.sessions.resolvePublicPluginAsset(input), null);
  const other = fixture();
  const active = await other.sessions.exchange("account", signal());
  for (const [key, value] of other.profiles)
    other.profiles.set(key, { ...value, revoked: true });
  await assert.rejects(
    other.sessions.resolvePublicPluginAsset({
      cookie: active.setCookie.split(";")[0]!,
      signal: signal(),
    }),
    /pim_control_profile_denied/,
  );
});

test("refreshed credentials in two tabs keep one verified account Cookie, fixed expiry and independent account isolation", async () => {
  const f = fixture(1);
  const a = await f.sessions.exchange("account-old-token", signal());
  f.setTime(f.getTime() + 10000);
  const b = await f.sessions.exchange("account-refreshed-token", signal());
  assert.deepEqual(b.session, a.session);
  const cookie = a.setCookie.split(";", 1)[0]!;
  for (const pimAccessToken of [
    "account-old-token",
    "account-refreshed-token",
  ]) {
    assert.deepEqual(
      await f.sessions.resolve({ cookie, userAgent: null, pimAccessToken }),
      a.session,
    );
    await f.sessions.verifyControlToken(a.session.controlAccessToken, signal());
  }
  assert.equal(
    await f.sessions.resolve({
      cookie,
      userAgent: null,
      pimAccessToken: "other-account",
    }),
    null,
  );
  assert.equal(await f.sessions.resolve({ cookie, userAgent: null }), null);
  f.denyAccount();
  assert.equal(
    await f.sessions.resolve({
      cookie,
      userAgent: null,
      pimAccessToken: "account-old-token",
    }),
    null,
  );
  await assert.rejects(
    f.sessions.verifyControlToken(a.session.controlAccessToken, signal()),
  );
});

test("private Worker owner and profile lookups require the original live account and are withdrawn with its session", async () => {
  const f = fixture();
  const created = await f.sessions.exchange("account", signal());
  const actor = pimControlAccountActor(f.account);
  const scope = await f.sessions.pluginProfile(actor, signal());
  assert.deepEqual(await f.sessions.executionActor(actor, signal()), actor);
  assert.deepEqual(
    (await f.sessions.executionProfile(scope, signal())).actor,
    actor,
  );
  assert.equal(
    await f.sessions.executionActor({ ...actor, actorId: "foreign" }, signal()),
    null,
  );
  await assert.rejects(
    f.sessions.executionProfile({ ...scope, profileId: "foreign" }, signal()),
  );
  f.denyAccount();
  await assert.rejects(
    f.sessions.executionActor(actor, signal()),
    /pim_account_denied/,
  );
  f.sessions.revokeCookie(created.setCookie.split(";")[0]!);
  assert.equal(await f.sessions.executionActor(actor, signal()), null);
});

test("a refreshed token cannot reuse the old Cookie after the durable account profile changes", async () => {
  const f = fixture();
  const first = await f.sessions.exchange("account", signal());
  const [key, profile] = [...f.profiles.entries()][0]!;
  f.profiles.set(key, {
    ...profile,
    scope: { ...profile.scope, profileId: "replacement-profile" },
  });
  assert.equal(
    await f.sessions.resolve({
      cookie: first.setCookie.split(";")[0]!,
      userAgent: null,
      pimAccessToken: "refreshed-account",
    }),
    null,
  );
  const second = await f.sessions.exchange("refreshed-account", signal());
  assert.notEqual(second.session.sessionId, first.session.sessionId);
});
