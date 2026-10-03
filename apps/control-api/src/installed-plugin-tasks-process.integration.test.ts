import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import {
  installedProcessActor as actor,
  installedProcessScope as scope,
  installedProcessDefaultAgent,
} from "../../runtime-worker/src/installed-plugin-worker-process.test-support.ts";
import { installedReleaseProcessPackagesMissing } from "../../runtime-worker/src/installed-plugin-release-process.test-support.ts";
import {
  installedTaskProcessFixture,
  waitTaskProcess,
} from "./installed-plugin-tasks-process.test-support.ts";
import {
  taskProcessCreditScope,
  taskProcessPeerToken,
} from "./installed-plugin-tasks-process-authorities.test-support.ts";

test(
  "actual production PG first-ever HTTP configuration and CLI publication lead to BFF-installed report tasks through the private Worker and personal-credit transaction",
  {
    timeout: 150_000,
    skip:
      installedReleaseProcessPackagesMissing ||
      !process.env.CREWON_TEST_POSTGRES_URL
        ? "actual outside-built Report v1/v2 and Root-owned PostgreSQL URL are required"
        : false,
  },
  async (t) => {
    const f = await installedTaskProcessFixture(t);
    let proof: Record<string, unknown> | null = null;
    try {
      assert.equal(f.workerFixture.modelRequests.length, 0);
      assert.equal(f.supplier.requests().length, 0);
      const [old, current] = f.prepared.document.entries;
      assert.ok(old && current);
      const pluginId = old.packageIdentity.pluginId;
      const configuration = await f.request(
        `/api/v1/extensions/${pluginId}/configuration?revision=1`,
      );
      assert.equal(configuration.status, 200, configuration.text);
      assert.deepEqual(configuration.body.configuration, old.configuration);
      const activated = await f.request(
        `/api/v1/extensions/${pluginId}/activation`,
        {
          configurationRevision: old.configuration.revision,
          expectedRevision: 0,
          state: "enabled",
          agentVersionId: old.target.agentVersionId,
        },
        "PUT",
        "named-process-activate-v1",
      );
      if (activated.status !== 200) {
        const direct = await fetch(
          `${f.peerOrigin}/private/v1/installed-plugins`,
          {
            method: "POST",
            signal: AbortSignal.timeout(10_000),
            headers: {
              "content-type": "application/json",
              "authorization": `Bearer ${taskProcessPeerToken}`,
            },
            body: JSON.stringify({
              protocol: "crewon.installed-plugin-peer-request.v1",
              requestId: "named-failure-diagnostic",
              operation: "readiness",
              actor,
              scope,
              identity: {
                ...old.packageIdentity,
                manifestDigest: old.configuration.manifestDigest,
                implementationDigest: old.configuration.implementationDigest,
              },
              configuration: old.configuration,
              expectedTarget: old.target,
            }),
          },
        );
        t.diagnostic(
          `actual private readiness diagnostic ${direct.status} ${await direct.text()}`,
        );
        t.diagnostic(`actual Worker errors: ${f.worker.stderr()}`);
        t.diagnostic(
          `Control authority actions: ${JSON.stringify(f.authority.state.requests.map((r) => ({ path: r.path, action: r.body.action })))}`,
        );
      }
      assert.equal(activated.status, 200, activated.text);
      assert.deepEqual(activated.body.activation.target, old.target);

      const deniedCsrf = await f.browser.request("/api/v1/threads", {
        method: "POST",
        body: { title: "No CSRF task" },
        idempotencyKey: "named-missing-csrf",
      });
      assert.equal(deniedCsrf.status, 403, deniedCsrf.text);
      assert.equal(deniedCsrf.body.error.code, "browser_csrf_invalid");
      const strippedActor = await f.browser.request("/api/v1/threads", {
        method: "POST",
        body: { title: "No caller identity" },
        csrfToken: f.csrfToken,
        idempotencyKey: "named-forged-actor",
        extraHeaders: { "x-crewon-actor-id": "forged-actor" },
      });
      assert.equal(strippedActor.status, 201, strippedActor.text);
      const trustedThread = await f.store.loadThreadInSpace({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        threadId: strippedActor.body.thread.threadId as string,
      });
      assert.equal(trustedThread?.createdByActorId, actor.actorId);
      assert.notEqual(trustedThread?.createdByActorId, "forged-actor");

      const createThread = async (key: string) => {
        const response = await f.request(
          "/api/v1/threads",
          { title: "Actual installed Report HTTP task" },
          "POST",
          key,
        );
        assert.equal(response.status, 201, response.text);
        return response.body.thread as { threadId: string; revision: number };
      };
      const mount = async (index: number, revision: number) => {
        const entry = f.prepared.document.entries[index]!;
        const response = await f.request("/api/v1/plugins/ui/mounts", {
          pluginId,
          contributionId: "studio",
          expectedSelectionRevision: revision,
          expectedPackageDigest: entry.packageIdentity.packageDigest,
        });
        assert.equal(response.status, 200, response.text);
        assert.equal(
          response.body.lease?.packageDigest ?? response.body.packageDigest,
          entry.packageIdentity.packageDigest,
        );
        return response.body.mountRef as string;
      };
      const invoke = (
        mountRef: string,
        thread: { threadId: string; revision: number },
        key: string,
      ) =>
        f.request(`/api/v1/plugins/ui/mounts/${mountRef}/actions`, {
          action: "report.generate",
          input: {
            threadId: thread.threadId,
            expectedThreadRevision: thread.revision,
            idempotencyKey: key,
            input: { subject: "Actual HTTP action supplier fixture" },
          },
        });
      const oldMount = await mount(0, f.selection.revision);
      const firstThread = await createThread("named-process-thread-v1");
      f.authority.state.quoteAvailable = false;
      const noQuote = await invoke(
        oldMount,
        firstThread,
        "named-process-no-quote",
      );
      assert.ok(noQuote.status >= 400, noQuote.text);
      const noRun = await f.database.query(
        `SELECT count(*)::int AS count FROM "${f.schema}".run_snapshots`,
      );
      assert.equal(noRun.rows[0].count, 0, "missing quote cannot create a Run");
      assert.equal(
        (await f.credits.getAccount(taskProcessCreditScope))?.reservedCredits,
        "0",
      );
      f.authority.state.quoteAvailable = true;

      const first = await invoke(
        oldMount,
        firstThread,
        "named-process-paid-v1",
      );
      assert.equal(first.status, 200, first.text);
      assert.equal(first.body.output.disposition, "committed");
      const firstRunId = first.body.output.runId as string;
      const locator = (runId: string) => ({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        runId,
      });
      const firstBinding = await f.store
        .extensionStore()
        .loadExtensionRunBinding(locator(firstRunId));
      assert.deepEqual(firstBinding?.target, old.target);
      const firstPin = await f.store.extensionStore().loadPluginTaskAdmission!(
        locator(firstRunId),
      );
      assert.ok(firstPin);
      assert.equal(firstPin.packageDigest, old.packageIdentity.packageDigest);
      assert.equal(firstPin.publisherId, old.packageIdentity.publisherId);
      assert.equal(firstPin.profileId, scope.profileId);
      assert.equal(firstPin.principalId, actor.principalId);
      assert.equal(firstPin.actorId, actor.actorId);
      assert.equal(firstPin.selectionRevision, f.selection.revision);
      const replay = await invoke(
        oldMount,
        firstThread,
        "named-process-paid-v1",
      );
      assert.equal(replay.status, 200, replay.text);
      assert.equal(replay.body.output.runId, firstRunId);
      assert.equal(
        (await f.credits.getAccount(taskProcessCreditScope))?.reservedCredits,
        "30",
      );
      await waitTaskProcess(
        "first actual HTTP-admitted Run completion",
        async () =>
          (await f.store.loadRunInSpace(locator(firstRunId)))?.status ===
          "completed",
        f.children,
      );

      const newSelection = await f.select(1);
      const currentActivation = await f.request(
        `/api/v1/extensions/${pluginId}/activation`,
        {
          configurationRevision: current.configuration.revision,
          expectedRevision: activated.body.activation.revision,
          state: "enabled",
          agentVersionId: current.target.agentVersionId,
        },
        "PUT",
        "named-process-activate-v2",
      );
      assert.equal(currentActivation.status, 200, currentActivation.text);
      assert.deepEqual(
        currentActivation.body.activation.target,
        current.target,
      );
      const newMount = await mount(1, newSelection.revision);
      const secondThread = await createThread("named-process-thread-v2");
      f.browser.state.beforeActionDelivery = async () => {
        const actual = await f.database.query(
          `SELECT count(*)::int AS count FROM "${f.schema}".plugin_task_admissions`,
        );
        assert.equal(
          actual.rows[0].count,
          2,
          "withdrawal is after the real second commit",
        );
        f.authority.state.uiAllowed = false;
      };
      const second = await invoke(
        newMount,
        secondThread,
        "named-process-paid-v2",
      );
      f.browser.state.beforeActionDelivery = null;
      assert.equal(second.status, 200, second.text);
      assert.equal(
        second.body.output.disposition,
        "committed",
        "late delivery withdrawal preserves the actual accepted receipt",
      );
      const secondRunId = second.body.output.runId as string;
      await waitTaskProcess(
        "second actual HTTP-admitted Run completion",
        async () =>
          (await f.store.loadRunInSpace(locator(secondRunId)))?.status ===
          "completed",
        f.children,
      );
      const secondBinding = await f.store
        .extensionStore()
        .loadExtensionRunBinding(locator(secondRunId));
      assert.deepEqual(secondBinding?.target, current.target);
      assert.deepEqual(
        await f.store
          .extensionStore()
          .loadExtensionRunBinding(locator(firstRunId)),
        firstBinding,
      );
      const secondPin = await f.store.extensionStore().loadPluginTaskAdmission!(
        locator(secondRunId),
      );
      assert.equal(
        secondPin?.packageDigest,
        current.packageIdentity.packageDigest,
      );
      assert.notEqual(firstPin.packageDigest, secondPin?.packageDigest);
      assert.equal(
        (await f.credits.getAccount(taskProcessCreditScope))?.reservedCredits,
        "60",
      );
      const withdrawn = await invoke(
        newMount,
        secondThread,
        "named-process-paid-v2-after-withdrawal",
      );
      assert.ok(withdrawn.status >= 400, withdrawn.text);
      const afterWithdraw = await f.database.query(
        `SELECT count(*)::int AS count FROM "${f.schema}".plugin_task_admissions`,
      );
      assert.equal(afterWithdraw.rows[0].count, 2);

      const defaultThread = await createThread("named-process-default-thread");
      const ordinary = await f.request(
        `/api/v1/threads/${defaultThread.threadId}/turns`,
        {
          expectedRevision: defaultThread.revision,
          content: "Keep the original default Agent.",
          agentVersionId: null,
          executionIntent: "none",
        },
        "POST",
        "named-process-default-turn",
      );
      assert.equal(ordinary.status, 201, ordinary.text);
      const defaultRunId = ordinary.body.run.runId as string;
      await waitTaskProcess(
        "ordinary default Run completion",
        async () =>
          (await f.store.loadRunInSpace(locator(defaultRunId)))?.status ===
          "completed",
        f.children,
      );
      assert.equal(
        (await f.store.loadRunInSpace(locator(defaultRunId)))?.agentVersionId,
        installedProcessDefaultAgent,
      );
      assert.equal(
        await f.store
          .extensionStore()
          .loadExtensionRunBinding(locator(defaultRunId)),
        null,
      );
      assert.equal(
        (await f.credits.getAccount(taskProcessCreditScope))?.reservedCredits,
        "60",
      );
      const posts = f.supplier
        .requests()
        .filter((request) => request.method === "POST");
      assert.deepEqual(
        posts.map((request) => JSON.parse(request.body!).pluginVersion),
        ["1.0.0", "2.0.0"],
      );
      assert.equal(f.workerFixture.modelRequests.length, 5);
      const holds = await f.credits.listEntries({
        scope: taskProcessCreditScope,
        afterRevision: 0,
        limit: 50,
      });
      assert.deepEqual(
        holds.map((entry) => entry.kind),
        ["grant", "reserve", "reserve"],
      );
      assert.ok(
        f.authority.state.requests.some(
          (request) => request.path === "/session",
        ),
      );
      assert.ok(
        f.authority.state.requests.some(
          (request) => request.path === "/verify",
        ),
      );
      assert.ok(
        f.authority.state.requests.some((request) => request.path === "/quote"),
      );
      proof = {
        schemaVersion: "crewon.installed-plugin-tasks-process-test-proof.v2",
        mode: "actual production PostgreSQL Control/BFF/Worker child processes",
        fixtureBoundaries: {
          operatorPrerequisite:
            "actual verifier/installer immutable bytes and installation ledger only; no configuration, Agent, release, task, funds or activation from setup",
          publication:
            "actual release-main child; one complete activated bundle",
          configuration:
            "first-ever original HTTP schema read, revisions1/2 with disabled selections and no peer/runtime/quote/funds, receipt-first replay after selection changes; original HTTP activation only after actual CLI publication",
          funding: "named-process-test-grant-only",
          quote:
            "named HTTPS authority fixture; 30 personal test credits per task",
          supplier:
            "deterministic local Report supplier; not an enterprise online API",
          excludedClaims: [
            "query",
            "credit settlement",
            "production funding rules",
          ],
        },
        actor,
        scope,
        prepublication: f.prepublication,
        releaseId: f.prepared.plan.bundle.releaseId,
        csrfMissingStatus: deniedCsrf.status,
        callerActorHeader: {
          ignored: true,
          persistedActorId: trustedThread?.createdByActorId,
        },
        missingQuote: {
          status: noQuote.status,
          runCount: noRun.rows[0].count,
          reservedCredits: "0",
        },
        tasks: [
          { runId: firstRunId, admission: firstPin, binding: firstBinding },
          { runId: secondRunId, admission: secondPin, binding: secondBinding },
        ],
        replayRunId: replay.body.output.runId,
        lateWithdrawal: {
          acceptedDisposition: second.body.output.disposition,
          subsequentActionStatus: withdrawn.status,
          admissionCount: afterWithdraw.rows[0].count,
        },
        creditEntries: holds,
        finalReservedCredits: "60",
        supplierPosts: posts.map((request) => ({
          executionId: request.executionId,
          pluginVersion: JSON.parse(request.body!).pluginVersion,
        })),
        modelRequestCount: f.workerFixture.modelRequests.length,
        defaultRun: {
          runId: defaultRunId,
          agentVersionId: installedProcessDefaultAgent,
          pluginBinding: null,
        },
      };
      t.diagnostic(
        "actual production children: metadata-only PG Control+BFF first-ever HTTP revisions1/2, then actual CLI publication and full-task Control+private Worker; two original HTTP actions, two personal test reservations, two version-pinned supplier POSTs, one ordinary default Run; operator installation only, no configuration seed/query/settlement claim",
      );
    } finally {
      await f.close();
    }
    assert.ok(proof);
    const children = await Promise.all(
      f.children.map((child) => child.completion),
    );
    assert.ok(f.children.every((child) => child.finished()));
    await writeFile(
      new URL(
        "../../../output/extensions/checks/installed-plugin-tasks-process-proof-20261003.json",
        import.meta.url,
      ),
      `${JSON.stringify(
        {
          ...proof,
          cleanup: {
            children,
            childrenPhysicallyClosed: true,
            ownSchemaDropped: true,
            ownPoolsClosed: true,
            temporaryFiles:
              "owned node:test after hooks remove both fixture directories",
          },
        },
        null,
        2,
      )}\n`,
    );
  },
);
