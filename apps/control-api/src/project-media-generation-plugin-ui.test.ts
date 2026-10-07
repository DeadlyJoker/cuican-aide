import assert from "node:assert/strict";
import test from "node:test";
import { ControlApiClient } from "@crewon/control-client";
import { PROJECT_MEDIA_GENERATE_UI_ACTION } from "@crewon/contracts/project-media-generations";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { mediaGenerationUiFixture } from "./project-media-generation-plugin-ui.test-support.ts";
import { barrier } from "./project-media-generation-runtime.test-support.ts";
import { composeDesktopProjectPluginUiDispatch } from "./desktop-project-plugin-ui-dispatch.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  for (const kind of ["T10", "D18"] as const)
    test(
      `${backend} ${kind}: genuine plugin UI and authenticated client share original Run and replay without material I/O`,
      assetTestOptions(backend),
      async (t) => {
        const f = await mediaGenerationUiFixture(t, backend, { kind });
        const before = await f.countRuns();
        const accepted = await f.invoke();
        assert.equal(accepted.disposition, "committed");
        assert.equal(accepted.threadId, f.binding.threadId);
        assert.equal(
          (await f.countRuns()).run_snapshots,
          before.run_snapshots! + 1,
        );
        const io = [f.state.sourceGets, f.state.uploads, f.state.targetGets];
        assert.equal(f.state.uploads, kind === "T10" ? 1 : 3);
        const client = new ControlApiClient({
          baseUrl: "http://control.test",
          accessToken: f.headers.authorization.slice(7),
          csrfToken: f.headers["x-csrf-token"],
          origin: f.headers.origin,
          fetch: async (url, init) => {
            const headers: Record<string, string> = {};
            new Headers(init?.headers).forEach((value, name) => {
              headers[name] = value;
            });
            const r = await f.app.inject({
              method: "POST",
              url: new URL(String(url)).pathname,
              headers,
              payload: String(init?.body),
            });
            return new Response(r.body, {
              status: r.statusCode,
              headers: { "content-type": "application/json" },
            });
          },
        });
        assert.deepEqual(
          await client.projectMediaGenerations.generate(f.command),
          { ...accepted, disposition: "replayed" },
        );
        assert.deepEqual(await f.invoke(), {
          ...accepted,
          disposition: "replayed",
        });
        assert.deepEqual(
          [f.state.sourceGets, f.state.uploads, f.state.targetGets],
          io,
        );
        assert.equal(
          (await f.countRuns()).run_snapshots,
          before.run_snapshots! + 1,
        );
        assert.equal(
          f.uiOwner.committedTasks.isOutcome(f.stateUi.outcomes[0]),
          false,
        );
        assert.throws(() =>
          f.uiOwner.committedTasks.verify(
            f.stateUi.contexts[0]!,
            f.stateUi.outcomes[0]!,
          ),
        );
      },
    );
  for (const options of [
    { declared: false },
    { publication: `sha256:${"b".repeat(64)}` },
  ])
    test(
      `${backend}: generation rejects absent declaration or foreign publication ${JSON.stringify(options)}`,
      assetTestOptions(backend),
      async (t) => {
        const f = await mediaGenerationUiFixture(t, backend, options),
          before = await f.countRuns();
        await assert.rejects(f.invoke());
        assert.equal(f.state.uploads, 0);
        assert.equal(f.state.sourceGets, 0);
        assert.deepEqual(await f.countRuns(), before);
      },
    );
  test(
    `${backend}: copied context and unknown namespace cannot fall through to a task owner`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationUiFixture(t, backend);
      f.stateUi.afterOutcome = () => {
        f.stateUi.allowed = false;
      };
      const accepted = await f.invoke();
      assert.equal(
        accepted.disposition,
        "committed",
        "durable receipt survives late UI policy withdrawal",
      );
      const context = f.stateUi.contexts[0]!;
      assert.throws(() =>
        f.owner.generateFromPluginUi(
          { ...context },
          new AbortController().signal,
        ),
      );
      await assert.rejects(f.invoke());
      const dispatch = composeDesktopProjectPluginUiDispatch({
        projects: undefined,
        texts: undefined,
        history: undefined,
        tasks: f.core,
      });
      await assert.rejects(
        dispatch.actions.invoke({
          ...context,
          action: PROJECT_MEDIA_GENERATE_UI_ACTION,
        }),
      );
      await assert.rejects(
        dispatch.actions.invoke({
          ...context,
          action: "crewon.project-media-generations.v9.unknown",
        }),
      );
    },
  );
  test(
    `${backend}: live UI withdrawal inside material upload prevents upload and original Run admission`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationUiFixture(t, backend),
        before = await f.countRuns();
      f.state.onAuthorize = async (p) => {
        if (p.action === "projectMaterial:upload") f.stateUi.allowed = false;
      };
      await assert.rejects(f.invoke());
      assert.equal(f.state.uploads, 0);
      assert.deepEqual(await f.countRuns(), before);
    },
  );
  test(
    `${backend}: closing UI joins material preparation while preserving borrowed HTTP runtime`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationUiFixture(t, backend),
        entered = barrier(),
        release = barrier();
      f.state.onAuthorize = async (p) => {
        if (p.action === "projectMaterial:upload") {
          entered.resolve();
          await release.promise;
        }
      };
      const pending = assert.rejects(f.invoke());
      await entered.promise;
      let closed = false;
      const closing = f.uiOwner.close().then(() => {
        closed = true;
      });
      await new Promise<void>((r) => setImmediate(r));
      assert.equal(closed, false);
      release.resolve();
      await pending;
      await closing;
      assert.equal(f.state.uploads, 0);
      f.state.onAuthorize = undefined;
      const accepted = await f.post();
      assert.equal(accepted.statusCode, 200, accepted.body);
      assert.equal(f.runtimeState.closed, 0);
    },
  );
  test(
    `${backend}: simultaneous UI and HTTP retries converge on one admitted Run`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationUiFixture(t, backend),
        entered = barrier(),
        release = barrier();
      const before = await f.countRuns();
      f.state.onAuthorize = async (p) => {
        if (p.action === "projectMaterial:upload") {
          entered.resolve();
          await release.promise;
        }
      };
      const ui = f.invoke();
      await entered.promise;
      const http = Promise.resolve(f.post());
      release.resolve();
      const [first, second] = await Promise.all([ui, http]);
      assert.equal(second.statusCode, 200, second.body);
      assert.equal(first.runId, second.json().runId);
      assert.deepEqual([first.disposition, second.json().disposition].sort(), [
        "committed",
        "replayed",
      ]);
      assert.equal(f.state.uploads, 1);
      assert.equal(
        (await f.countRuns()).run_snapshots,
        before.run_snapshots! + 1,
      );
    },
  );
  test(
    `${backend}: service negotiation grants only the approved package and supported API`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationUiFixture(t, backend);
      const fallback = {
        isAvailable: (r: { requirement: { service: string } }) =>
          r.requirement.service === "named.existing",
      };
      const services = f.uiOwner.hostUiServices(fallback);
      const request = {
        scope: {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          profileId: f.pin.profileId,
        },
        candidate: {
          descriptor: f.descriptor,
          packageDigest: f.pin.packageDigest,
        },
        requirement: {
          service: "crewon.project-media-generations",
          apiVersion: "1",
          optional: true,
        },
      };
      assert.equal(services.isAvailable(request), true);
      assert.equal(
        services.isAvailable({
          ...request,
          requirement: { ...request.requirement, apiVersion: "2" },
        }),
        true,
      );
      assert.equal(
        services.isAvailable({
          ...request,
          requirement: { ...request.requirement, apiVersion: "3" },
        }),
        false,
      );
      assert.equal(
        services.isAvailable({
          ...request,
          candidate: {
            ...request.candidate,
            packageDigest: `sha256:${"b".repeat(64)}`,
          },
        }),
        false,
      );
      assert.equal(
        services.isAvailable({
          ...request,
          requirement: { ...request.requirement, service: "named.existing" },
        }),
        true,
      );
      await f.uiOwner.close();
      assert.equal(services.isAvailable(request), false);
    },
  );
}
