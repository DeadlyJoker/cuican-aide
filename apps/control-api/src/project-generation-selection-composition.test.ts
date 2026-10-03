import assert from "node:assert/strict";
import test from "node:test";
import { captureCreativeProjectCompositionConfig } from "./creative-project-composition.ts";
import {
  captureProjectGenerationSelectionConfiguration,
  composeOwnedProjectGenerationSelectionService,
  assertProjectGenerationSelectionUiComposition,
} from "./project-generation-selection-composition.ts";
import { projectConceptSelectionFixture } from "../../../packages/application/src/project-concept-selection.test-support.ts";
import { captureProductionPluginUiActions } from "./production-plugin-ui-composition.ts";
import { createProductionPluginUiRequestService } from "./production-plugin-ui-request-service.ts";
import type { PluginUiControlService } from "./plugin-control-route.ts";

test("selection storage and source UI opt-ins are independent; defaults acquire no extra adapter", () => {
  let calls = 0;
  const service = composeOwnedProjectGenerationSelectionService({
    projects: undefined,
    generationReads: undefined,
    owner: {
      extensionStore: () => {
        calls++;
        throw new Error("unexpected adapter");
      },
      externalOperationStore: () => {
        calls++;
        throw new Error("unexpected operation");
      },
    },
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-10-04T00:00:00.000Z" },
    digester: { sha256: () => "unused" },
  });
  assert.equal(service, undefined);
  assert.equal(calls, 0);
  const authorization = {
    authorize: async () => ({ outcome: "allow" as const }),
  };
  const verifier = {
    verifyImage: () => {
      throw new Error("not called");
    },
  };
  assert.throws(
    () =>
      captureCreativeProjectCompositionConfig({
        authorization,
        resultSelections: {
          version: "crewon.project-concept-selection.v1",
          verifier,
        },
      }),
    /project_generation_selection_reader_required/u,
  );
  assert.throws(
    () =>
      captureCreativeProjectCompositionConfig({
        authorization,
        selectionUi: {
          publications: [
            {
              pluginId: "example.selection",
              packageDigest: `sha256:${"a".repeat(64)}`,
              contributionId: "workbench",
            },
          ],
        },
      }),
    /project_generation_selection_ui_store_required/u,
  );
});
test("trusted verifier callback is bound before startup and getters or unknown configuration do not execute", () => {
  let getters = 0;
  const getter = {
    get verifyImage() {
      getters++;
      throw new Error("must not read");
    },
  };
  assert.throws(() =>
    captureProjectGenerationSelectionConfiguration({
      version: "crewon.project-concept-selection.v1",
      verifier: getter,
    }),
  );
  assert.equal(getters, 0);
  assert.throws(() =>
    captureProjectGenerationSelectionConfiguration({
      version: "other",
      verifier: {
        verifyImage: () => {
          throw new Error("no");
        },
      },
    }),
  );
  assert.throws(() =>
    captureProjectGenerationSelectionConfiguration({
      version: "crewon.project-concept-selection.v1",
      verifier: {
        verifyImage: () => {
          throw new Error("no");
        },
      },
      providerUrl: "https://other.test",
    }),
  );
});
test("source UI requires approved exact package and actual reader; paid capability is not implied", async () => {
  const f = await projectConceptSelectionFixture();
  const publication = f.uiSource.publication.publication.source;
  const configuration = { publications: [publication] };
  assert.throws(
    () =>
      assertProjectGenerationSelectionUiComposition({
        configuration,
        publications: [],
        hasReader: true,
        ui: {},
        owned: undefined,
      }),
    { code: "creative_project_plugin_publication_unapproved" },
  );
  assert.throws(
    () =>
      assertProjectGenerationSelectionUiComposition({
        configuration,
        publications: [publication],
        hasReader: false,
        ui: {},
        owned: undefined,
      }),
    /selection_ui_reader_required/u,
  );
  assert.throws(
    () =>
      captureProductionPluginUiActions({
        configuration: {} as never,
        ownedProjectSelectionActions: {} as never,
      }),
    /selection_owner_invalid/u,
  );
});
test("reserved selection family never falls through ordinary UI or task dispatch when disabled", async () => {
  let calls = 0;
  const ui = {
    invoke: async () => {
      calls++;
      return null;
    },
  } as unknown as PluginUiControlService;
  // A metadata runtime is enough to install request orchestration, but does not grant selection.
  const service = createProductionPluginUiRequestService({
    ui,
    projects: {} as never,
  });
  for (const action of [
    "crewon.project-generation-selections",
    "crewon.project-generation-selections.v1.getConceptSelection",
    "crewon.project-generation-selections.v9.selectConceptImage",
  ]) {
    await assert.rejects(
      async () =>
        service.invokeAuthenticatedRequest!(
          { method: "POST", url: "/", remoteAddress: "127.0.0.1", headers: {} },
          { tenantId: "t", spaceId: "s", principalId: "p", actorId: "a" },
          { mountRef: "r".repeat(40), action, input: {} },
          new AbortController().signal,
        ),
      { code: "plugin_ui_actions_unavailable" },
    );
  }
  assert.equal(calls, 0);
});
