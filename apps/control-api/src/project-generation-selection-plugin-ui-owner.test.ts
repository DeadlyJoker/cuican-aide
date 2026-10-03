import assert from "node:assert/strict";
import test from "node:test";
import {
  PluginUiApplicationService,
  type PluginUiActionContext,
  type PluginUiCommittedMetadataOutcome,
} from "@crewon/application";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import { projectConceptSelectionFixture } from "../../../packages/application/src/project-concept-selection.test-support.ts";
import { committedProjectGenerationFixture } from "../../../packages/application/src/plugin-ui-committed-project-generation.test-support.ts";
import { taskActor } from "../../../packages/application/src/extension-plugin-task.test-support.ts";
import {
  ProjectGenerationSelectionPluginUiOwner,
  combineSelectionCommittedMetadata,
  isProjectGenerationSelectionPluginUiOwner,
} from "./project-generation-selection-plugin-ui-owner.ts";

/** Actual registered UI and Application services over explicit memory ports; not a SQL or supplier proof. */
async function fixture() {
  const f = await projectConceptSelectionFixture();
  const business = committedProjectGenerationFixture();
  const original = business.detachedContext();
  const descriptor = parsePluginPackageDescriptor({
    ...original.lease.descriptor,
    requires: [
      {
        service: "crewon.project-generation-selections",
        apiVersion: "1",
        optional: true,
      },
    ],
  });
  const state = {
    allowed: true,
    context: null as PluginUiActionContext | null,
    outcome: null as PluginUiCommittedMetadataOutcome | null,
    afterOutcome: null as (() => void) | null,
  };
  const owner = new ProjectGenerationSelectionPluginUiOwner({
    configuration: { publications: [business.publication.source] },
    selections: f.service,
    authorization: {
      authorize: async () => {
        if (!state.allowed) throw new Error("source_request_withdrawn");
      },
    },
  });
  const ui = new PluginUiApplicationService({
    store: business.ledger,
    profiles: { resolve: async () => original.scope },
    authorization: {
      authorize: async () =>
        state.allowed
          ? { outcome: "allow", authorityEpoch: original.authorityEpoch }
          : { outcome: "deny", reasonCode: "withdrawn" },
    },
    packages: {
      verify: async () => ({ descriptor, publicAssets: ["ui.mjs"] }),
      readAsset: async () => ({
        bytes: new Uint8Array([1]),
        contentType: "text/javascript",
      }),
    },
    ids: { nextId: () => "r".repeat(40) },
    clock: { now: () => business.state.now },
    actions: {
      invoke: async (context) => {
        state.context = context;
        const value = await owner.actions.invoke(context);
        if (owner.committedMetadata.isOutcome(value)) state.outcome = value;
        state.afterOutcome?.();
        return value;
      },
    },
    committedMetadata: owner.committedMetadata,
  });
  const mount = await ui.openMount(taskActor, business.openCommand);
  const command = {
    mountRef: mount.mountRef,
    action: "crewon.project-generation-selections.v1.selectConceptImage",
    input: f.command,
  };
  return {
    f,
    business,
    original,
    descriptor,
    state,
    owner,
    ui,
    mount,
    command,
  };
}

test("registered selection owner uses exact original actor and source pin, returns an independently single-use metadata outcome", async () => {
  const x = await fixture();
  assert.equal(isProjectGenerationSelectionPluginUiOwner(x.owner), true);
  assert.equal(
    isProjectGenerationSelectionPluginUiOwner({ ...x.owner }),
    false,
  );
  const result = await x.ui.invoke(taskActor, x.command);
  assert.equal((result as { disposition: string }).disposition, "committed");
  assert.equal(
    (result as { selection: { filename: string } }).selection.filename,
    "second.webp",
  );
  assert.equal(x.f.state.commitOptions[0]!.source.kind, "installed-plugin-ui");
  const source = x.f.state.commitOptions[0]!.source;
  if (source.kind !== "installed-plugin-ui")
    throw new Error("missing actual source");
  assert.equal(source.publication.sourcePin.action, x.command.action);
  assert.deepEqual(source.publication.selection, x.state.context!.selection);
  assert.deepEqual(source.publication.package, x.state.context!.package);
  assert.equal(x.owner.committedMetadata.isOutcome(x.state.outcome), false);
  assert.throws(
    () => x.owner.committedMetadata.verify(x.state.context!, x.state.outcome!),
    { code: "plugin_ui_committed_metadata_invalid" },
  );
  const read = await x.ui.invoke(taskActor, {
    mountRef: x.mount.mountRef,
    action: "crewon.project-generation-selections.v1.getConceptSelection",
    input: {
      projectId: x.f.saved.query.projectId,
      assetId: x.f.saved.query.assetId,
    },
  });
  assert.equal((read as { selectionRevision: number }).selectionRevision, 1);
  await x.owner.close();
});
test("selection COMMIT acknowledgement survives actual mount and owner withdrawal without a postcommit policy check", async () => {
  const x = await fixture();
  x.f.state.afterCommit = () => {
    x.state.allowed = false;
    void x.owner.close();
    void x.ui.closeMount(taskActor, { mountRef: x.mount.mountRef });
  };
  const value = await x.ui.invoke(taskActor, x.command);
  assert.equal((value as { disposition: string }).disposition, "committed");
  assert.equal(x.f.state.receipts.size, 1);
  await x.owner.close();
  await assert.rejects(() => x.owner.actions.invoke(x.state.context!), {
    code: "plugin_project_generation_selection_unavailable",
  });
});
test("fake or replaced context, absent declaration and unknown namespace never dispatch selection", async () => {
  const x = await fixture();
  let getters = 0;
  await assert.rejects(
    () =>
      x.owner.actions.invoke({
        get actor() {
          getters++;
          throw new Error("must not read");
        },
      } as unknown as PluginUiActionContext),
    { code: "plugin_ui_invocation_unavailable" },
  );
  assert.equal(getters, 0);
  x.business.state.selection = null;
  await assert.rejects(() => x.ui.invoke(taskActor, x.command));
  assert.equal(x.f.state.commitOptions.length, 0);
  await x.owner.close();
  const y = await fixture();
  await assert.rejects(() =>
    y.ui.invoke(taskActor, {
      ...y.command,
      action: "crewon.project-generation-selections.v2.selectConceptImage",
    }),
  );
  assert.equal(y.f.state.commitOptions.length, 0);
  await y.owner.close();
});
test("metadata composition cannot certify JSON or reuse a consumed cross-context capability", async () => {
  const x = await fixture();
  const combined = combineSelectionCommittedMetadata(
    x.owner.committedMetadata,
    {
      isOutcome: (
        _value: unknown,
      ): _value is PluginUiCommittedMetadataOutcome => false,
      verify: () => {
        throw new Error("wrong owner");
      },
    },
  );
  assert.equal(combined.isOutcome({ disposition: "committed" }), false);
  x.state.afterOutcome = () => {
    assert.ok(x.state.outcome);
    assert.equal(combined.isOutcome(x.state.outcome), true);
    assert.throws(
      () => combined.verify({ ...x.state.context! }, x.state.outcome!),
      { code: "plugin_ui_committed_metadata_invalid" },
    );
    assert.equal(combined.isOutcome(x.state.outcome), false);
  };
  await assert.rejects(() => x.ui.invoke(taskActor, x.command));
  assert.equal(x.f.state.receipts.size, 1);
  await x.owner.close();
});
