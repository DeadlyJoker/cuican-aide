import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { InvokePluginUiActionCommand } from "@crewon/application";
import { createFixture } from "../../../packages/application/src/creative-project.test-support.ts";
import { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import type { InstalledPluginPeerPrepared } from "./installed-plugin-peer-client.ts";
import {
  actor,
  digester,
  identityFixture,
  request,
  scope,
} from "./installed-plugin-task.test-support.ts";
import type { PluginUiControlService } from "./plugin-control-route.ts";
import { createProductionCreativeProjectPluginRuntime } from "./production-creative-project-plugin-runtime.ts";
import { parseProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import { createProductionPluginUiRequestService } from "./production-plugin-ui-request-service.ts";
import { installedGenerationFixture } from "./installed-plugin-project-generation-owner.test-support.ts";
import type { InstalledPluginProjectGenerationOwner } from "./installed-plugin-project-generation-owner.ts";

const listCommand: InvokePluginUiActionCommand = {
  mountRef: "m".repeat(40),
  action: "crewon.creative-projects.v1.listProjects",
  input: { query: {} },
};
const taskCommand: InvokePluginUiActionCommand = {
  mountRef: listCommand.mountRef,
  action: "crewon.business-task.request",
  input: { prompt: "fixture" },
};

function uiService(
  invoke: PluginUiControlService["invoke"],
): PluginUiControlService {
  const unused = async (): Promise<never> => {
    throw new Error("unexpected_non_action_ui_call");
  };
  return {
    catalog: unused,
    openMount: unused,
    validateMount: unused,
    renewMount: unused,
    readAsset: unused,
    closeMount: unused,
    invoke,
  };
}

function taskFixture(t: TestContext) {
  const identity = identityFixture();
  let preparations = 0;
  const prepared: InstalledPluginPeerPrepared = {
    catalog: { list: () => [], resolve: () => null },
    host: {
      taskAdmissionMode: () => "installed",
      validateConfiguration: async () => {},
      evaluate: async () => ({
        outcome: "unavailable",
        reasonCode: "extension_runtime_unavailable",
      }),
    },
    pluginQueryHost: {
      resolveRegistration: async () => null,
      evaluate: async () => ({
        outcome: "unavailable",
        reasonCode: "extension_runtime_unavailable",
      }),
    },
  };
  const owner = new InstalledPluginRequestOwner({
    identity: identity.identity,
    profiles: { resolve: async () => scope },
    peer: {
      prepare: async (input) => {
        preparations++;
        assert.deepEqual(input, { actor, scope });
        return prepared;
      },
    },
  });
  t.after(() => owner.close());
  return { owner, preparations: () => preparations, ...identity };
}

function metadataFixture(t: TestContext) {
  const identity = identityFixture();
  const projects = createFixture();
  const publication = {
    pluginId: "fixture.drama",
    packageDigest: digester.sha256("metadata-package"),
    contributionId: "workbench",
  };
  let profileReads = 0;
  const runtime = createProductionCreativeProjectPluginRuntime({
    identity: identity.identity,
    projects: {
      service: projects.service,
      pluginUi: { publications: [publication] },
    },
    ui: parseProductionPluginUiConfiguration({
      installRoot: "/fixture-installed-root",
      profileAuthority: {
        url: "https://metadata.fixture.test/profile",
        serviceToken: "profile-token-" + "p".repeat(32),
      },
      policyAuthority: {
        url: "https://metadata.fixture.test/policy",
        serviceToken: "policy-token-" + "s".repeat(32),
      },
      publications: [
        {
          ...publication,
          publisherId: "fixture.publisher",
          publicAssets: ["ui.mjs"],
        },
      ].map(({ contributionId: _contributionId, ...item }) => item),
      timeoutMs: 1000,
    }),
    fetch: async (input, init) => {
      assert.equal(String(input), "https://metadata.fixture.test/profile");
      assert.equal(init?.signal?.aborted, false);
      profileReads++;
      return Response.json(scope);
    },
  });
  assert.ok(runtime);
  t.after(() => runtime.close());
  return { runtime, profileReads: () => profileReads, ...identity };
}

test("unconfigured generation names never borrow task authority or fall through to ordinary UI actions", async (t) => {
  const tasks = taskFixture(t);
  let invoked = 0;
  const ui = createProductionPluginUiRequestService({
    ui: uiService(async () => {
      invoked++;
      return null;
    }),
    taskRequests: tasks.owner,
  });
  for (const action of [
    "crewon.project-generations.v1.generateConcept",
    "crewon.project-generations.v2.generateConcept",
    "crewon.project-generations.",
  ]) {
    assert.throws(
      () =>
        ui.invokeAuthenticatedRequest!(
          request,
          actor,
          { ...taskCommand, action },
          new AbortController().signal,
        ),
      /plugin_ui_actions_unavailable/u,
    );
  }
  assert.equal(invoked, 0);
  assert.equal(tasks.preparations(), 0);
  assert.equal(tasks.calls(), 0);
});

test("configured generation rejects unknown actions and identity or prompt injection before preparing execution", async (t) => {
  const tasks = taskFixture(t);
  const generation = await installedGenerationFixture(t);
  let invoked = 0;
  const ui = createProductionPluginUiRequestService({
    ui: uiService(async () => {
      invoked++;
      return null;
    }),
    taskRequests: tasks.owner,
    projectGenerations: generation.owner,
  });
  for (const action of [
    "crewon.project-generations.v1.query",
    "crewon.project-generations.v2.generateConcept",
    "crewon.project-generations.",
  ]) {
    assert.throws(
      () =>
        ui.invokeAuthenticatedRequest!(
          request,
          actor,
          { ...taskCommand, action, input: generation.request },
          new AbortController().signal,
        ),
      /project_generation_ui_action_invalid/u,
    );
  }
  for (const input of [
    { ...generation.request, prompt: "browser override" },
    { ...generation.request, principalId: "browser payer" },
    { ...generation.request, executionPin: { pluginId: "browser target" } },
  ]) {
    assert.throws(
      () =>
        ui.invokeAuthenticatedRequest!(
          request,
          actor,
          {
            ...taskCommand,
            action: "crewon.project-generations.v1.generateConcept",
            input,
          },
          new AbortController().signal,
        ),
      /plugin_ui_fields_invalid/u,
    );
  }
  assert.equal(invoked, 0);
  assert.equal(tasks.preparations(), 0);
  assert.equal(tasks.calls(), 0);
  assert.equal(generation.nodeState.calls, 0);
  assert.equal(generation.nodeState.quoteCalls, 0);
  assert.equal((await generation.counts()).links, 0);
});

test("the generation HTTP dispatcher requires its actual owner brand and the original request owner", () => {
  for (const projectGenerations of [
    {},
    { taskOwner: {}, actions: { invoke: async () => null } },
  ])
    assert.throws(
      () =>
        createProductionPluginUiRequestService({
          ui: uiService(async () => null),
          projectGenerations:
            projectGenerations as unknown as InstalledPluginProjectGenerationOwner,
        }),
      /production_plugin_ui_generation_request_owner_invalid/u,
    );
});

test("unknown reserved metadata names are rejected before execution peer preparation", async (t) => {
  const tasks = taskFixture(t);
  const metadata = metadataFixture(t);
  let invoked = 0;
  const ui = createProductionPluginUiRequestService({
    ui: uiService(async () => {
      invoked++;
      return null;
    }),
    taskRequests: tasks.owner,
    projects: metadata.runtime,
  });
  for (const action of [
    "crewon.creative-projects.v1.notAnAction",
    "crewon.creative-projects.v2.listProjects",
    "crewon.creative-projects.",
  ]) {
    assert.throws(
      () =>
        ui.invokeAuthenticatedRequest!(
          request,
          actor,
          { ...listCommand, action },
          new AbortController().signal,
        ),
      /plugin_creative_project_action_invalid/u,
    );
  }
  assert.equal(invoked, 0);
  assert.equal(tasks.preparations(), 0);
  assert.equal(tasks.calls(), 0);
  assert.equal(metadata.profileReads(), 0);
  assert.equal(metadata.calls(), 0);
});

test("missing metadata owner never falls back to the installed task request owner", async (t) => {
  const tasks = taskFixture(t);
  let invoked = 0;
  const ui = createProductionPluginUiRequestService({
    ui: uiService(async () => {
      invoked++;
      return null;
    }),
    taskRequests: tasks.owner,
  });
  for (const action of [
    listCommand.action,
    "crewon.creative-projects.v1.unknown",
  ]) {
    assert.throws(
      () =>
        ui.invokeAuthenticatedRequest!(
          request,
          actor,
          { ...listCommand, action },
          new AbortController().signal,
        ),
      /plugin_ui_actions_unavailable/u,
    );
  }
  assert.equal(invoked, 0);
  assert.equal(tasks.preparations(), 0);
  assert.equal(tasks.calls(), 0);
});

test("known metadata actions borrow their own actual identity/profile request and preserve the invoke result", async (t) => {
  const tasks = taskFixture(t);
  const metadata = metadataFixture(t);
  const output = { projects: [], nextCursor: null };
  let invoked = 0;
  const ui = createProductionPluginUiRequestService({
    ui: uiService(async (currentActor, command) => {
      invoked++;
      assert.equal(currentActor, actor);
      assert.equal(command, listCommand);
      assert.throws(() => tasks.owner.currentActor(), /authority_unavailable/u);
      return output;
    }),
    taskRequests: tasks.owner,
    projects: metadata.runtime,
  });
  assert.equal(
    await ui.invokeAuthenticatedRequest!(
      request,
      actor,
      listCommand,
      new AbortController().signal,
    ),
    output,
  );
  assert.equal(invoked, 1);
  assert.ok(metadata.calls() > 0);
  assert.ok(metadata.profileReads() > 0);
  assert.equal(tasks.preparations(), 0);
  assert.equal(tasks.calls(), 0);
});

test("metadata reads recheck the actual request identity after the UI invoke await", async (t) => {
  const tasks = taskFixture(t);
  const metadata = metadataFixture(t);
  const ui = createProductionPluginUiRequestService({
    ui: uiService(async () => {
      metadata.setActor({ ...actor, principalId: "revoked-after-read" });
      return { projects: [], nextCursor: null };
    }),
    taskRequests: tasks.owner,
    projects: metadata.runtime,
  });
  await assert.rejects(
    ui.invokeAuthenticatedRequest!(
      request,
      actor,
      listCommand,
      new AbortController().signal,
    ),
    /installed_plugin_request_authority_unavailable/u,
  );
  assert.equal(tasks.preparations(), 0);
});

test("task actions still execute inside the original actual task request owner", async (t) => {
  const tasks = taskFixture(t);
  const metadata = metadataFixture(t);
  const output = { receipt: "existing-task-receipt" };
  const ui = createProductionPluginUiRequestService({
    ui: uiService(async (currentActor, command) => {
      assert.equal(currentActor, actor);
      assert.equal(command, taskCommand);
      assert.deepEqual(tasks.owner.currentActor(), actor);
      assert.deepEqual(tasks.owner.currentScope(), scope);
      return output;
    }),
    taskRequests: tasks.owner,
    projects: metadata.runtime,
  });
  assert.equal(
    await ui.invokeAuthenticatedRequest!(
      request,
      actor,
      taskCommand,
      new AbortController().signal,
    ),
    output,
  );
  assert.equal(tasks.preparations(), 1);
  assert.ok(tasks.calls() > 0);
  assert.equal(metadata.calls(), 0);
  assert.equal(metadata.profileReads(), 0);
});

test("metadata-only composition leaves unrelated actions on the original UI service", async (t) => {
  const metadata = metadataFixture(t);
  let invoked = 0;
  const ui = createProductionPluginUiRequestService({
    ui: uiService(async (currentActor, command) => {
      invoked++;
      assert.equal(currentActor, actor);
      assert.equal(command, taskCommand);
      return null;
    }),
    projects: metadata.runtime,
  });
  assert.equal(
    await ui.invokeAuthenticatedRequest!(
      request,
      actor,
      taskCommand,
      new AbortController().signal,
    ),
    null,
  );
  assert.equal(invoked, 1);
  assert.equal(metadata.calls(), 0);
  assert.equal(metadata.profileReads(), 0);
});

test("without either owner the original service and its preexisting HTTP request method are retained", () => {
  let invoked = 0;
  const ui: PluginUiControlService = {
    ...uiService(async () => null),
    invokeAuthenticatedRequest: async () => {
      invoked++;
      return null;
    },
  };
  const composed = createProductionPluginUiRequestService({ ui });
  assert.equal(composed, ui);
  assert.equal(
    composed.invokeAuthenticatedRequest,
    ui.invokeAuthenticatedRequest,
  );
  assert.equal(invoked, 0);
});
