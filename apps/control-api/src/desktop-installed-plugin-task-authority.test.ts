import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ApplicationError } from "@crewon/application";
import { SqliteRunStore } from "@crewon/store";
import { extensionCanonicalJson } from "@crewon/domain";
import { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import { createDesktopPluginSourceRegistry } from "./desktop-plugin-source-registry.ts";
import { parseDesktopInstalledPluginActivationConfig } from "./desktop-installed-plugin-activation-environment.ts";
import { parseDesktopInstalledPluginTaskConfig } from "./desktop-installed-plugin-task-environment.ts";
import {
  actor,
  scope,
  nativeTaskAuthorityFixture,
  nativeTaskDeferred,
  nativeTaskDigester,
  nativeTaskQuote,
} from "./desktop-installed-plugin-task-authority.test-support.ts";

const nativeOnly = { skip: process.platform === "win32" };
const withdrawn = /desktop_plugin_task_authority_unavailable/;

test(
  "Native authority uses real request/profile and independent task/package/exact quote policies without activation permission",
  nativeOnly,
  async (t) => {
    const f = await nativeTaskAuthorityFixture(t);
    assert.equal(f.owner.requests, f.installed.requests);
    f.owner.assertBinding(f.binding);
    const result = await f.run(
      async () => ({
        profile: await f.owner.profiles.resolve(actor),
        business: await f.owner.businessAuthorization.authorize(
          f.businessRequest,
        ),
        package: await f.owner.authorizePackage(
          f.packageRequest,
          f.installed.requests.currentSignal(),
        ),
        quote: await f.owner.creditQuotes.quoteGeneration(f.quoteInput),
      }),
      { preparation: "execution" },
    );
    assert.deepEqual(result, {
      profile: scope,
      business: { outcome: "allow" },
      package: "allow",
      quote: nativeTaskQuote,
    });
    assert.equal(f.peerCalls.length, 1);
    assert.equal(f.peerCalls[0]!.operation, "catalog");
    assert.deepEqual(
      f.calls.filter((call) => call.role === "task").map((call) => call.input),
      [f.businessRequest],
    );
    assert.deepEqual(
      f.calls.filter((call) => call.role === "quote").map((call) => call.input),
      [f.quoteInput],
    );
    assert.deepEqual(f.calls.find((call) => call.role === "package")!.input, {
      schemaVersion: "crewon.plugin-execution-package.v1",
      identity: {
        pluginId: f.source.pluginId,
        publisherId: f.source.publisherId,
        version: f.source.version,
        packageDigest: f.source.packageDigest,
      },
      scope,
      purpose: "submit",
    });
    assert.equal(
      f.calls.filter((call) => call.role === "activation").length,
      0,
    );
  },
);

test(
  "actual Native profile UI authorization works outside request ALS with one combined lease epoch",
  nativeOnly,
  async (t) => {
    const f = await nativeTaskAuthorityFixture(t);
    const expectedEpoch = nativeTaskDigester
      .sha256(
        extensionCanonicalJson({
          nativeEpoch: f.binding.configuration.authorityEpoch,
          publicationDigest: nativeTaskDigester.sha256(
            extensionCanonicalJson(f.binding.tasks.publication),
          ),
          policyEpoch: "named-remote-native-task-ui-epoch",
        }),
      )
      .slice(7);
    for (const action of ["mount", "asset", "invoke", "catalog"] as const)
      assert.deepEqual(
        await f.owner.uiAuthorization.authorize({ ...f.uiRequest, action }),
        { outcome: "allow", authorityEpoch: expectedEpoch },
      );
    const scopeCatalog = {
      actor,
      action: "catalog" as const,
      resource: {
        kind: "pluginUi" as const,
        ...scope,
        pluginId: null,
        packageDigest: null,
        contributionId: null,
        selectionRevision: null,
      },
    };
    assert.deepEqual(await f.owner.uiAuthorization.authorize(scopeCatalog), {
      outcome: "allow",
      authorityEpoch: expectedEpoch,
    });
    assert.deepEqual(f.calls.at(-1)!.input, {
      ...scopeCatalog,
      action: "pluginUi:catalog",
    });
    f.state.responses.ui = {
      outcome: "allow",
      authorityEpoch: "named-remote-native-task-ui-revoked-epoch",
    };
    const changed = await f.owner.uiAuthorization.authorize(f.uiRequest);
    assert.equal(changed.outcome, "allow");
    if (changed.outcome === "allow")
      assert.notEqual(changed.authorityEpoch, expectedEpoch);
    assert.equal(
      f.peerCalls.length,
      0,
      "a UI lease policy never prepares a Worker or starts a task",
    );
    assert.equal(
      f.calls.every((call) => call.role === "ui"),
      true,
    );
  },
);

test(
  "task/profile/package/quote require the real authenticated request and reject foreign UI scope before HTTP",
  nativeOnly,
  async (t) => {
    const f = await nativeTaskAuthorityFixture(t);
    await assert.rejects(f.owner.profiles.resolve(actor));
    await assert.rejects(
      f.owner.businessAuthorization.authorize(f.businessRequest),
    );
    await assert.rejects(
      f.owner.authorizePackage(f.packageRequest, new AbortController().signal),
    );
    await assert.rejects(f.owner.creditQuotes.quoteGeneration(f.quoteInput));
    await assert.rejects(
      f.run(() => f.owner.businessAuthorization.authorize(f.businessRequest), {
        request: {
          ...f.request(),
          headers: {
            ...f.request().headers,
            authorization: "Bearer invalid-original-session",
          },
        },
      }),
    );
    await assert.rejects(
      f.run(() => f.owner.profiles.resolve(actor), {
        actor: { ...actor, principalId: "foreign-principal" },
      }),
    );
    await assert.rejects(
      f.owner.uiAuthorization.authorize({
        ...f.uiRequest,
        actor: { ...actor, principalId: "foreign-principal" },
      }),
      withdrawn,
    );
    await assert.rejects(
      f.owner.uiAuthorization.authorize({
        ...f.uiRequest,
        resource: { ...f.uiRequest.resource, profileId: "foreign-profile" },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ApplicationError);
        assert.equal(error.category, "authorization");
        assert.equal(error.code, "desktop_plugin_profile_mismatch");
        return true;
      },
    );
    assert.equal(f.calls.length, 0);
    assert.equal(f.peerCalls.length, 0);
  },
);

test(
  "activation-only decisions never grant tasks and copies or another actual borrowed owner are rejected",
  nativeOnly,
  async (t) => {
    const f = await nativeTaskAuthorityFixture(t, {
      publicationSource: "programmatic",
    });
    await f.seedDeployment();
    assert.deepEqual(
      await f.activationOwner.authorizeActivate(
        actor,
        f.source.pluginId,
        new AbortController().signal,
      ),
      { outcome: "allow" },
    );
    assert.equal(
      f.calls.filter((call) => call.role === "activation").length,
      1,
    );
    f.state.responses.task = {
      outcome: "deny",
      reasonCode: "named-task-policy-denied-after-activation",
    };
    assert.deepEqual(
      await f.run(() =>
        f.owner.businessAuthorization.authorize(f.businessRequest),
      ),
      f.state.responses.task,
    );
    assert.throws(() => f.createAuthority({ tasks: { ...f.binding.tasks } }));
    assert.throws(() => f.createAuthority({ installed: { ...f.installed } }));
    assert.throws(() => f.createAuthority({ installed: f.metadataOnly }));
    assert.throws(() =>
      f.createAuthority({
        activation: parseDesktopInstalledPluginActivationConfig(
          f.activationDocument,
          f.environment,
        ),
      }),
    );
    const otherAuthority = new DesktopPluginAuthority(f.binding.configuration);
    const otherRegistry = await createDesktopPluginSourceRegistry(
      f.binding.configuration,
    );
    const otherStore = new SqliteRunStore(
      join(f.root, "other-actual-native-store.sqlite"),
    );
    t.after(async () => {
      await otherAuthority.close();
      await otherStore.close();
    });
    assert.throws(() => f.createAuthority({ authority: otherAuthority }));
    assert.throws(() => f.createAuthority({ registry: otherRegistry }));
    assert.throws(() => f.createAuthority({ store: otherStore }));
    const taskCalls = f.calls.filter((call) => call.role === "task").length;
    const unsupported = await f.run(() =>
      f.owner.businessAuthorization.authorize({
        ...f.businessRequest,
        action: "extension:activate",
      }),
    );
    assert.equal(unsupported.outcome, "deny");
    assert.equal(
      f.calls.filter((call) => call.role === "task").length,
      taskCalls,
    );
  },
);

test(
  "issued task publications must bind the exact Native actor/profile/root/epoch/activation and independently approved UI source",
  nativeOnly,
  async (t) => {
    const f = await nativeTaskAuthorityFixture(t, {
      publicationSource: "programmatic",
    });
    const changes = [
      { actor: { ...actor, principalId: "different-principal" } },
      { scope: { ...scope, profileId: "different-profile" } },
      { installRoot: "/private/different-installed-root" },
      { authorityEpoch: "different-native-owner-epoch-00000001" },
      { activationDigest: `sha256:${"0".repeat(64)}` },
      {
        uiPublications: [
          {
            ...f.taskDocument.uiPublications[0]!,
            pluginId: "test.foreign-workbench",
          },
        ],
      },
      {
        uiPublications: [
          {
            ...f.taskDocument.uiPublications[0]!,
            packageDigest: `sha256:${"0".repeat(64)}`,
          },
        ],
      },
    ];
    for (const change of changes)
      assert.throws(
        () =>
          f.createAuthority({
            tasks: parseDesktopInstalledPluginTaskConfig(
              { ...f.taskDocument, ...change },
              f.environment,
            ),
          }),
        withdrawn,
      );
    assert.equal(f.calls.length, 0);
  },
);

test(
  "the four independent authority decisions cannot substitute for each other",
  nativeOnly,
  async (t) => {
    const f = await nativeTaskAuthorityFixture(t);
    const business = () =>
      f.run(() => f.owner.businessAuthorization.authorize(f.businessRequest));
    const packageDecision = () =>
      f.run(() =>
        f.owner.authorizePackage(
          f.packageRequest,
          f.installed.requests.currentSignal(),
        ),
      );
    const quote = () =>
      f.run(() => f.owner.creditQuotes.quoteGeneration(f.quoteInput));
    const ui = () => f.owner.uiAuthorization.authorize(f.uiRequest);
    f.state.responses.task = {
      outcome: "deny",
      reasonCode: "named-independent-task-denied",
    };
    assert.deepEqual(await business(), f.state.responses.task);
    assert.equal(await packageDecision(), "allow");
    assert.deepEqual(await quote(), nativeTaskQuote);
    assert.equal((await ui()).outcome, "allow");
    f.state.responses.task = { outcome: "allow" };
    f.state.responses.ui = {
      outcome: "deny",
      reasonCode: "named-independent-ui-denied",
    };
    assert.deepEqual(await ui(), f.state.responses.ui);
    assert.equal((await business()).outcome, "allow");
    assert.equal(await packageDecision(), "allow");
    assert.deepEqual(await quote(), nativeTaskQuote);
    f.state.responses.ui = {
      outcome: "allow",
      authorityEpoch: "named-remote-native-task-ui-epoch",
    };
    f.state.responses.package = { outcome: "deny" };
    assert.equal(await packageDecision(), "deny");
    assert.equal((await business()).outcome, "allow");
    assert.equal((await ui()).outcome, "allow");
    assert.deepEqual(await quote(), nativeTaskQuote);
    f.state.responses.package = { outcome: "allow" };
    f.state.statuses.quote = 403;
    await assert.rejects(
      quote(),
      /installed_plugin_task_authority_unavailable/,
    );
    assert.equal((await business()).outcome, "allow");
    assert.equal(await packageDecision(), "allow");
    assert.equal((await ui()).outcome, "allow");
    assert.equal(
      f.calls.filter((call) => call.role === "activation").length,
      0,
    );
  },
);

test(
  "exact quotes preserve large integer credit strings and reject invented amounts, changed input and malformed authority prices",
  nativeOnly,
  async (t) => {
    const f = await nativeTaskAuthorityFixture(t);
    assert.deepEqual(
      await f.run(() => f.owner.creditQuotes.quoteGeneration(f.quoteInput)),
      nativeTaskQuote,
    );
    const originalCalls = f.calls.length;
    for (const input of [
      { ...f.quoteInput, quotedCredits: "1" },
      { ...f.quoteInput, principalId: "different-payer" },
      { ...f.quoteInput, input: { organization: "Different original input" } },
      { ...f.quoteInput, actor: { ...actor, actorId: "foreign-actor" } },
    ])
      await assert.rejects(
        f.run(() => f.owner.creditQuotes.quoteGeneration(input)),
      );
    let getters = 0;
    const input = Object.defineProperty({ ...f.quoteInput }, "actor", {
      enumerable: true,
      get() {
        getters++;
        return actor;
      },
    });
    await assert.rejects(
      f.run(() => f.owner.creditQuotes.quoteGeneration(input)),
    );
    assert.equal(getters, 0);
    assert.equal(f.calls.length, originalCalls);
    for (const value of [
      { ...nativeTaskQuote, quotedCredits: "0" },
      { ...nativeTaskQuote, quotedCredits: "01" },
      { ...nativeTaskQuote, quotedCredits: "1.5" },
      { ...nativeTaskQuote, quotedCredits: 30 },
      { ...nativeTaskQuote, priceRevision: 0 },
      { ...nativeTaskQuote, payer: "invented-payer" },
    ]) {
      f.state.responses.quote = value;
      await assert.rejects(
        f.run(() => f.owner.creditQuotes.quoteGeneration(f.quoteInput)),
      );
    }
  },
);

test(
  "unapproved packages and foreign task/UI resources stop before their independent PDP",
  nativeOnly,
  async (t) => {
    const f = await nativeTaskAuthorityFixture(t);
    assert.equal(
      await f.run(() =>
        f.owner.authorizePackage(
          {
            ...f.packageRequest,
            candidate: {
              ...f.packageRequest.candidate,
              descriptor: {
                ...f.descriptor,
                publisherId: "test.foreign-publisher",
              },
            },
          },
          f.installed.requests.currentSignal(),
        ),
      ),
      "deny",
    );
    await assert.rejects(
      f.run(() =>
        f.owner.businessAuthorization.authorize({
          ...f.businessRequest,
          resource: {
            kind: "extension",
            tenantId: actor.tenantId,
            spaceId: actor.spaceId,
            pluginId: "test.foreign-business",
          },
        }),
      ),
      withdrawn,
    );
    await assert.rejects(
      f.run(() =>
        f.owner.businessAuthorization.authorize({
          ...f.businessRequest,
          resource: {
            kind: "extension",
            tenantId: actor.tenantId,
            spaceId: "foreign-space",
            pluginId: f.source.pluginId,
          },
        }),
      ),
      withdrawn,
    );
    assert.equal(
      (
        await f.owner.uiAuthorization.authorize({
          ...f.uiRequest,
          resource: {
            ...f.uiRequest.resource,
            contributionId: "unapproved-contribution",
          },
        })
      ).outcome,
      "deny",
    );
    assert.equal(
      (
        await f.owner.uiAuthorization.authorize({
          ...f.uiRequest,
          resource: {
            ...f.uiRequest.resource,
            packageDigest: `sha256:${"f".repeat(64)}`,
          },
        })
      ).outcome,
      "deny",
    );
    assert.equal(f.calls.length, 0);
  },
);

test(
  "real private task and activation file changes revoke new calls and late policy results",
  nativeOnly,
  async (t) => {
    for (const file of ["task", "activation"] as const) {
      await t.test(file, async (t) => {
        const f = await nativeTaskAuthorityFixture(t);
        const path = file === "task" ? f.taskPath : f.activationPath;
        const document =
          file === "task" ? f.taskDocument : f.activationDocument;
        f.state.before.task = async () => {
          await writeFile(path, JSON.stringify(document) + "\n", {
            mode: 0o600,
          });
        };
        await assert.rejects(
          f.run(() =>
            f.owner.businessAuthorization.authorize(f.businessRequest),
          ),
          withdrawn,
        );
        assert.equal(f.calls.filter((call) => call.role === "task").length, 1);
        await assert.rejects(
          f.owner.uiAuthorization.authorize(f.uiRequest),
          withdrawn,
        );
        const before = f.calls.length;
        await assert.rejects(
          f.run(() => f.owner.creditQuotes.quoteGeneration(f.quoteInput)),
        );
        assert.equal(f.calls.length, before);
      });
    }
    await t.test("mode", async (t) => {
      const f = await nativeTaskAuthorityFixture(t);
      await chmod(f.taskPath, 0o644);
      await assert.rejects(
        f.owner.uiAuthorization.authorize(f.uiRequest),
        withdrawn,
      );
      assert.equal(f.calls.length, 0);
    });
  },
);

test(
  "real profile sidecar replacement and Native withdrawal reject before business or UI I/O",
  nativeOnly,
  async (t) => {
    for (const change of ["profile", "authority"] as const)
      await t.test(change, async (t) => {
        const f = await nativeTaskAuthorityFixture(t);
        if (change === "profile") await f.replaceProfileLock();
        else f.authority.withdraw();
        await assert.rejects(
          f.owner.uiAuthorization.authorize(f.uiRequest),
          withdrawn,
        );
        await assert.rejects(
          f.run(() =>
            f.owner.businessAuthorization.authorize(f.businessRequest),
          ),
        );
        assert.equal(f.calls.length, 0);
      });
  },
);

test(
  "closing the actual borrowed configuration runtime revokes task UI without closing activation, installation or SQLite",
  nativeOnly,
  async (t) => {
    const f = await nativeTaskAuthorityFixture(t);
    await f.installed.close();
    await assert.rejects(
      f.owner.uiAuthorization.authorize(f.uiRequest),
      withdrawn,
    );
    assert.equal(f.calls.length, 0);
    const prepared = await f.activationOwner.peer.prepare({ actor, scope });
    assert.ok(prepared.catalog.resolve(f.configuration));
    const pkg = await f.installation.service.getPackage(actor, {
      packageDigest: f.source.packageDigest,
    });
    assert.ok(pkg);
    assert.ok(
      await f.store
        .pluginInstallationStore()
        .loadSelection({ scope, pluginId: f.source.pluginId }),
    );
  },
);

test(
  "authority close withdraws all four policy ports and joins raw fetch that ignores cancellation while borrowed resources survive",
  nativeOnly,
  async (t) => {
    for (const role of ["task", "ui", "package", "quote"] as const)
      await t.test(role, async (t) => {
        const f = await nativeTaskAuthorityFixture(t);
        const entered = nativeTaskDeferred(),
          release = nativeTaskDeferred();
        let signal: AbortSignal | undefined;
        f.state.before[role] = async (current) => {
          signal = current;
          entered.resolve();
          await release.promise;
        };
        const action =
          role === "ui"
            ? f.owner.uiAuthorization.authorize(f.uiRequest)
            : f.run<unknown>(() =>
                role === "task"
                  ? f.owner.businessAuthorization.authorize(f.businessRequest)
                  : role === "package"
                    ? f.owner.authorizePackage(
                        f.packageRequest,
                        f.installed.requests.currentSignal(),
                      )
                    : f.owner.creditQuotes.quoteGeneration(f.quoteInput),
              );
        const observed = action.then(
          () => ({ outcome: "resolved" as const }),
          (error: unknown) => ({ outcome: "rejected" as const, error }),
        );
        let closed = false;
        let closing: Promise<void> | undefined;
        try {
          await entered.promise;
          closing = f.owner.close().then(() => {
            closed = true;
          });
          await new Promise<void>((done) => setImmediate(done));
          assert.equal(signal?.aborted, true);
          assert.equal(
            closed,
            false,
            "logical cancellation must not complete actual HTTP close",
          );
          await assert.rejects(
            f.owner.uiAuthorization.authorize(f.uiRequest),
            withdrawn,
          );
          release.resolve();
          await closing;
          assert.equal((await observed).outcome, "rejected");
        } finally {
          release.resolve();
          await closing;
          await observed;
        }
        await f.run(async () => {
          await f.installed.requests.assertCurrent();
          assert.deepEqual(f.installed.requests.currentScope(), scope);
          assert.deepEqual(
            await f.installed.extensions.getConfiguration(actor, {
              pluginId: f.source.pluginId,
              revision: null,
            }),
            f.configuration,
          );
        });
        assert.ok(
          (
            await f.activationOwner.peer.prepare({ actor, scope })
          ).catalog.resolve(f.configuration),
        );
        assert.ok(
          await f.store
            .pluginInstallationStore()
            .loadSelection({ scope, pluginId: f.source.pluginId }),
        );
      });
  },
);

test(
  "authority close joins the original Standalone identity read inside its profile port",
  nativeOnly,
  async (t) => {
    const f = await nativeTaskAuthorityFixture(t);
    const entered = nativeTaskDeferred(),
      release = nativeTaskDeferred();
    const originalResolveActor = f.identity.resolveActor.bind(f.identity);
    let pause = false,
      closed = false;
    const patch = t.mock.method(
      f.identity,
      "resolveActor",
      async (request: Parameters<typeof f.identity.resolveActor>[0]) => {
        if (pause) {
          entered.resolve();
          await release.promise;
        }
        return originalResolveActor(request);
      },
    );
    const action = f.run(async () => {
      pause = true;
      return f.owner.profiles.resolve(actor);
    });
    const observed = action.then(
      () => "resolved",
      () => "rejected",
    );
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      closing = f.owner.close().then(() => {
        closed = true;
      });
      await new Promise<void>((done) => setImmediate(done));
      assert.equal(
        closed,
        false,
        "the profile port owns the physical borrowed identity await",
      );
      release.resolve();
      await closing;
      assert.equal(await observed, "rejected");
    } finally {
      pause = false;
      release.resolve();
      await closing;
      await observed;
      patch.mock.restore();
    }
    await f.run(async () => {
      await f.installed.requests.assertCurrent();
    });
    assert.ok(
      await f.store
        .pluginInstallationStore()
        .loadSelection({ scope, pluginId: f.source.pluginId }),
    );
  },
);
