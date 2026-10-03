import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { errorResponse } from "./control-api-errors.ts";
import { registerPluginControlRoutes } from "./plugin-control-route.ts";
import { createProductionPluginUiRuntime } from "./production-plugin-ui-composition.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { deferred } from "./installed-plugin-task-action-owner.test-support.ts";
import {
  actor,
  creditScope,
  generationAction,
  installedGenerationFixture,
  savedPrompt,
  scope,
} from "./installed-plugin-project-generation-owner.test-support.ts";
import {
  projectGenerationHttpsAuthority,
  projectGenerationProductionIdentity,
} from "./production-project-generation-ui.integration.test-support.ts";

/** Production UI/runtime and HTTP routes with real SQL/Node/TLS; identity, publisher policy and funding are explicit fixtures. */
async function fixture(
  t: Parameters<typeof installedGenerationFixture>[0],
  backend: "sqlite" | "postgres",
) {
  const f = await installedGenerationFixture(t, backend);
  const authority = await projectGenerationHttpsAuthority(t, {
    actor,
    profile: f.profile,
    sourceId: f.sourceId,
    sourceEpoch: () => f.state.sourceEpoch,
    targetEpoch: () => f.state.targetEpoch,
  });
  const authentication = projectGenerationProductionIdentity(actor);
  const runtime = createProductionPluginUiRuntime(
    {
      configuration: parseProductionPluginUiConfiguration({
        installRoot: f.installRoot,
        profileAuthority: authority.profileAuthority,
        policyAuthority: authority.policyAuthority,
        publications: [
          {
            pluginId: f.sourceId,
            publisherId: f.source.descriptor.publisherId,
            packageDigest: f.source.packageDigest,
            publicAssets: ["ui.mjs"],
          },
        ],
        timeoutMs: 1000,
      }),
      ownedTaskActions: f.taskOwner,
      ownedProjectGenerationActions: f.owner,
    },
    {
      ledger: f.ledger,
      clock: f.dependencies.clock,
      fetch: authority.fetch,
    },
  );
  const app = Fastify({ trustProxy: false });
  app.setErrorHandler((error, req, reply) => {
    const result = errorResponse(error, req.id);
    return reply.code(result.statusCode).send(result.body);
  });
  registerPluginControlRoutes(app, {
    identity: authentication.identity,
    pluginUi: runtime.service,
  });
  app.addHook("onClose", () => runtime.close());
  t.after(() => app.close());
  const opened = await app.inject({
    method: "POST",
    url: "/api/v1/plugins/ui/mounts",
    headers: authentication.headers,
    payload: {
      pluginId: f.sourceId,
      contributionId: "workbench",
      expectedSelectionRevision: f.sourceEnabled.selection.revision,
      expectedPackageDigest: f.source.packageDigest,
    },
  });
  assert.equal(opened.statusCode, 200, opened.body);
  const lease = opened.json<{
    mountRef: string;
    packageDigest: string;
    selectionRevision: number;
  }>();
  assert.notEqual(lease.mountRef, f.lease.mountRef);
  const invoke = (
    payload: Record<string, unknown> = {
      action: generationAction,
      input: f.request,
    },
    headers: Record<string, string> = authentication.headers,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      headers,
      payload,
    });
  return { ...f, authority, authentication, runtime, app, lease, invoke };
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 20_000,
  };
  test(
    `${backend} production UI HTTP generates from its original registered source mount with actual CA-validated HTTPS policy and replays one paid Run`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const response = await f.invoke();
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers["cache-control"], "no-store");
      const output = response.json<{
        output: { disposition: string; runId: string };
      }>().output;
      assert.equal(output.disposition, "committed");
      const actual = f.state.submissions[0]!;
      assert.deepEqual(actual.actor, actor);
      assert.equal(actual.sourcePin.pluginId, f.sourceId);
      assert.equal(actual.sourcePin.packageDigest, f.lease.packageDigest);
      assert.equal(
        actual.sourcePin.selectionRevision,
        f.lease.selectionRevision,
      );
      assert.equal(actual.sourcePin.authorityEpoch, f.state.sourceEpoch);
      assert.equal(actual.executionPin.pluginId, scope.pluginId);
      assert.equal(
        actual.executionPin.packageDigest,
        f.installed.packageDigest,
      );
      assert.equal(actual.executionPin.authorityEpoch, f.state.targetEpoch);
      assert.deepEqual(actual.command.intent, {
        kind: "generate",
        input: { prompt: savedPrompt },
      });
      // The earlier fixture's local Application action port was never invoked; production owns this new context and lease.
      assert.equal(f.state.lastContext, null);
      assert.equal(f.nodeState.accepted[0]!.binding.runId, output.runId);
      const link = await f.first.store.loadProjectGenerationLink(
        f.nodeState.accepted[0]!.binding,
      );
      assert.ok(link);
      assert.deepEqual(link.reference, f.reference);
      const counts = await f.counts();
      const account = await f.credits.getAccount(creditScope);
      const replay = await f.invoke();
      assert.equal(replay.statusCode, 200, replay.body);
      assert.deepEqual(replay.json().output, {
        ...output,
        disposition: "replayed",
      });
      assert.deepEqual(await f.counts(), counts);
      assert.deepEqual(await f.credits.getAccount(creditScope), account);
      assert.equal(f.nodeState.quoteCalls, 1);
      assert.equal(await f.count("run_snapshots"), 1);
      assert.equal(await f.count("creative_project_generation_links"), 1);
      assert.equal(account?.availableCredits, "70");
      assert.equal(account?.reservedCredits, "30");
      assert.equal(f.nodeState.setups, 2);
      assert.equal(f.nodeState.disposals, 2);
      assert.ok(f.authentication.reads() >= 3);
      assert.ok(f.authority.state.verifiedTlsConnections >= 6);
      for (const entry of f.authority.state.requests) {
        assert.deepEqual(entry.body.actor, actor);
        if (entry.path === "/profile") continue;
        const resource = entry.body.resource as Record<string, unknown>;
        assert.equal(resource.tenantId, actor.tenantId);
        assert.equal(resource.spaceId, actor.spaceId);
        assert.equal(resource.profileId, f.profile.profileId);
        assert.equal(resource.pluginId, f.sourceId);
        assert.equal(resource.packageDigest, f.source.packageDigest);
        assert.equal(resource.contributionId, "workbench");
        assert.equal(
          resource.selectionRevision,
          f.sourceEnabled.selection.revision,
        );
      }
      await f.runtime.close();
    },
  );

  test(
    `${backend} production generation HTTP rejects unknown actions and injected body/header authority without Node dispatch`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const before = await f.counts();
      const unknown = await f.invoke({
        action: "crewon.project-generations.v1.unknown",
        input: f.request,
      });
      assert.equal(unknown.statusCode, 403, unknown.body);
      assert.equal(
        unknown.json().error.code,
        "plugin_project_generation_action_invalid",
      );
      const envelope = await f.invoke({
        action: generationAction,
        input: f.request,
        actor,
      });
      assert.equal(envelope.statusCode, 400, envelope.body);
      const injected = await f.invoke({
        action: generationAction,
        input: {
          ...f.request,
          actor,
          payer: "caller-selected-funding",
          target: scope.pluginId,
        },
      });
      assert.notEqual(injected.statusCode, 200, injected.body);
      const header = await f.invoke(undefined, {
        ...f.authentication.headers,
        "x-crewon-principal-id": "injected-other-owner",
      });
      assert.equal(header.statusCode, 403, header.body);
      assert.equal(header.json().error.code, "actor_header_forbidden");
      assert.equal(f.nodeState.setups, 0);
      assert.equal(f.nodeState.calls, 0);
      assert.equal(f.nodeState.quoteCalls, 0);
      assert.equal(f.nodeState.accepted.length, 0);
      assert.deepEqual(await f.counts(), before);
      assert.equal(
        (await f.credits.getAccount(creditScope))?.availableCredits,
        "100",
      );
      await f.runtime.close();
    },
  );

  for (const change of ["profile", "policy"] as const) {
    test(
      `${backend} actual production HTTPS ${change} revocation during pricing rejects before COMMIT and preserves original paid state`,
      options,
      async (t) => {
        const f = await fixture(t, backend);
        const entered = deferred(),
          release = deferred();
        f.nodeState.quoteEntered = entered.resolve;
        f.nodeState.quoteGate = release.promise;
        const before = await f.counts();
        const requestCount = f.authority.state.requests.length;
        const invoking = f.invoke();
        await entered.promise;
        if (change === "profile") f.authority.state.changedProfile = true;
        else f.authority.state.policyDenied = true;
        release.resolve();
        const response = await invoking;
        assert.equal(response.statusCode, 403, response.body);
        assert.ok(f.authority.state.requests.length > requestCount);
        assert.deepEqual(await f.counts(), before);
        assert.equal(f.nodeState.accepted.length, 0);
        assert.equal(f.nodeState.quoteCalls, 1);
        assert.equal(f.nodeState.setups, 1);
        assert.equal(f.nodeState.disposals, 1);
        const account = await f.credits.getAccount(creditScope);
        assert.equal(account?.availableCredits, "100");
        assert.equal(account?.reservedCredits, "0");
        await f.runtime.close();
      },
    );
  }

  test(
    `${backend} production runtime close after the actual paid COMMIT preserves HTTP generation acknowledgement`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      let closing: Promise<void> | undefined;
      f.nodeState.afterCommit = async () => {
        assert.equal(await f.count("run_snapshots"), 1);
        assert.equal(await f.count("creative_project_generation_links"), 1);
        f.authority.state.changedProfile = true;
        f.authority.state.policyDenied = true;
        // The runtime joins the current actual owner action; let the original committed result reach its issuer first.
        closing = f.runtime.close();
      };
      const response = await f.invoke();
      await closing;
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().output.disposition, "committed");
      assert.equal(
        response.json().output.runId,
        f.nodeState.accepted[0]!.binding.runId,
      );
      assert.equal(f.nodeState.accepted.length, 1);
      assert.equal(await f.count("run_snapshots"), 1);
      assert.equal(
        (await f.credits.getAccount(creditScope))?.reservedCredits,
        "30",
      );
      assert.equal(f.nodeState.setups, 1);
      assert.equal(f.nodeState.disposals, 1);
      const after = await f.invoke();
      assert.equal(after.statusCode, 409, after.body);
      assert.equal(after.json().error.code, "plugin_ui_service_unavailable");
      assert.equal(f.nodeState.setups, 1);
    },
  );
}
