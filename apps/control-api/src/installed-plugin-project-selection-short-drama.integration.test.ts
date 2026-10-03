import assert from "node:assert/strict";
import test from "node:test";
import { installLocalPluginPackage } from "@crewon/plugin-host";
import {
  parseGetConceptSelectionResponse,
  parseSelectConceptImageResponse,
} from "@crewon/contracts";
import {
  installationRecipe,
  selectionRecipe,
} from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import {
  selectImageAction,
  selectionShortDramaFixture,
} from "./installed-plugin-project-selection-short-drama.integration.test-support.ts";

const packageDirectory =
  process.env.CREWON_SHORT_DRAMA_SELECTION_TEST_PACKAGE_DIRECTORY;
const domModule = process.env.CREWON_HAPPY_DOM_MODULE;
const manifestDigest =
  "b2df02e2ed6f5f5e4f7d61a770f9dc5b4d50a43f399bccccf59dcb8e4b12e05f";
const uiDigest =
  "6e2ea28fd176833578a226560e2cf902dd33d1d163b6958c39d26821fb0d53b6";
function release() {
  assert.ok(
    packageDirectory,
    "actual short-drama 7 package must be explicitly configured",
  );
  assert.ok(domModule, "actual DOM consumer must be explicitly configured");
  assert.match(
    manifestDigest,
    /^[a-f0-9]{64}$/u,
    "released manifest is not frozen yet",
  );
  assert.match(uiDigest, /^[a-f0-9]{64}$/u, "released UI is not frozen yet");
  return { packageDirectory, domModule, manifestDigest, uiDigest };
}
type Fixture = Awaited<ReturnType<typeof selectionShortDramaFixture>>;
type Mounted = Awaited<ReturnType<Fixture["mount"]>>;
const panel = (ui: Mounted) =>
  ui.container.querySelector<HTMLElement>('[aria-label="概念图选用"]');
const imageButton = (f: Fixture, ui: Mounted, index: number) =>
  ui.container.querySelector<HTMLButtonElement>(
    `[data-operation-id="${f.generation.operation.operationId}"] [data-result-index="${index}"] button`,
  );
const selectedIndex = (ui: Mounted) =>
  panel(ui)?.querySelector<HTMLElement>("[data-selected-result-index]")?.dataset
    .selectedResultIndex;
const writeCalls = (f: Fixture) =>
  f.calls.filter((call) => call.action === selectImageAction);
async function noAdditionalExecution(
  f: Fixture,
  before: Awaited<ReturnType<Fixture["counts"]>>,
  account: Awaited<ReturnType<Fixture["credits"]["getAccount"]>>,
) {
  assert.deepEqual(await f.counts(), before);
  assert.deepEqual(await f.credits.getAccount(f.creditScope), account);
  assert.equal(f.state.peerCalls, 0);
  assert.equal(f.state.unknownCalls, 0);
  assert.equal(f.policy.hostCalls, 0);
  assert.equal(f.supplierCalls(), 0);
  assert.equal(
    f.calls.filter(
      (call) =>
        call.action.startsWith("crewon.project-generations.") ||
        call.action.startsWith("crewon.project-generation-queries."),
    ).length,
    0,
  );
}

/** Optional published-package suite; once opted in, absent DOM/PG/release pins fail, never skip a backend. */
for (const backend of ["sqlite", "postgres"] as const) {
  const options = { skip: packageDirectory === undefined, timeout: 60_000 };
  test(
    `${backend} released short-drama 7 selects the second raw result through real client/journal/registered HTTP/same SQL and explicitly recovers UNKNOWN without rolling back a newer pointer`,
    options,
    async (t) => {
      if (backend === "postgres")
        assert.ok(
          process.env.CREWON_TEST_POSTGRES_URL,
          "the opted-in PostgreSQL case must run",
        );
      const f = await selectionShortDramaFixture(t, backend, release());
      const before = await f.counts(),
        account = await f.credits.getAccount(f.creditScope);
      let ui = await f.mount();
      await f.wait(() => imageButton(f, ui, 1)?.disabled === false);
      assert.equal(
        writeCalls(f).length,
        0,
        "opening a saved input never silently selects",
      );
      f.loseNextAcknowledgement();
      await ui.click(imageButton(f, ui, 1));
      await f.wait(
        () =>
          f.journal.current({ lease: ui.lease })?.phase === "uncertain" &&
          f.journal.current({ lease: ui.lease })?.retryable === true,
      );
      const original = f.journal.current({ lease: ui.lease })!;
      assert.deepEqual(original.input.reference, f.reference);
      assert.equal(
        original.input.operationId,
        f.generation.operation.operationId,
      );
      assert.equal(
        original.input.expectedOperationRevision,
        f.generation.operation.revision,
      );
      assert.equal(original.input.resultIndex, 1);
      assert.equal(original.input.expectedSelectionRevision, 0);
      assert.doesNotMatch(
        JSON.stringify(original.input),
        /url|filename|sourceRunId|actor|payer|prompt|target|threadId|tenantId|spaceId/u,
      );
      assert.equal(
        writeCalls(f)[0]!.status,
        200,
        "the lost response follows a confirmed real SQL commit",
      );
      const current = await f.client.creativeProjects.getConceptSelection({
        projectId: f.reference.projectId,
        assetId: f.reference.assetId,
      });
      assert.equal(current.current?.filename, "second.png");
      assert.equal(current.current?.resultIndex, 1);
      assert.equal(
        imageButton(f, ui, 0)?.disabled,
        true,
        "UNKNOWN locks fresh choices",
      );
      await ui.dispose();

      // Another authenticated command is a distinct user choice; old replay must never replace it.
      const { idempotencyKey: _originalKey, ...originalBody } = original.input;
      const newer = await f.client.creativeProjects.selectConceptImage(
        { ...originalBody, resultIndex: 0, expectedSelectionRevision: 1 },
        "other-window-explicit-selection",
      );
      assert.equal(newer.selectionRevision, 2);
      assert.equal(newer.selection.filename, "first.png");
      const project = await f.projects.getProject(f.actor, {
        projectId: f.reference.projectId,
      });
      const metadataMount = await f.openHttpMount();
      await f.client.plugins.invoke(metadataMount, {
        action: "crewon.creative-projects.v1.appendBrief",
        input: {
          projectId: project.projectId,
          request: {
            expectedProjectRevision: project.revision,
            text: "已保存的需求发生了变化。",
          },
          idempotencyKey: "selection-history-new-brief",
        },
      });
      await f.client.plugins.closeMount(metadataMount);

      const sent = writeCalls(f).length;
      ui = await f.mount();
      assert.equal(
        writeCalls(f).length,
        sent,
        "close/reopen cannot generate a fresh write or key",
      );
      await f.wait(() => !ui.button("重试原选用").disabled);
      await ui.click(ui.button("重试原选用"));
      await f.wait(
        () =>
          f.journal.current({ lease: ui.lease })?.phase === "accepted" &&
          selectedIndex(ui) === "0",
      );
      const accepted = f.journal.current({ lease: ui.lease })!;
      assert.deepEqual(accepted.input, original.input);
      assert.equal(accepted.receipt?.disposition, "replayed");
      assert.equal(accepted.receipt?.selection.filename, "second.png");
      assert.equal(
        accepted.receipt?.selectionRevision,
        1,
        "immutable receipt is historical",
      );
      assert.deepEqual(writeCalls(f)[1]!.input, writeCalls(f)[0]!.input);
      assert.equal(panel(ui)?.dataset.selectionRevision, "2");
      assert.match(panel(ui)?.textContent ?? "", /需重新确认/u);
      const latest = parseGetConceptSelectionResponse(
        await f.client.creativeProjects.getConceptSelection({
          projectId: f.reference.projectId,
          assetId: f.reference.assetId,
        }),
      );
      assert.equal(latest.current?.filename, "first.png");
      assert.equal(latest.current?.requiresConfirmation, true);
      await noAdditionalExecution(f, before, account);
      await ui.dispose();
    },
  );

  test(
    `${backend} actual selection journal records a physically late confirmed response after released ESM close and reopens accepted without dispatching another write`,
    options,
    async (t) => {
      if (backend === "postgres")
        assert.ok(process.env.CREWON_TEST_POSTGRES_URL);
      const f = await selectionShortDramaFixture(t, backend, release());
      const before = await f.counts(),
        account = await f.credits.getAccount(f.creditScope);
      const ui = await f.mount();
      await f.wait(() => imageButton(f, ui, 1)?.disabled === false);
      const acknowledge = f.holdNextAcknowledgement();
      try {
        await ui.click(imageButton(f, ui, 1));
        await f.wait(
          () => writeCalls(f).length === 1 && writeCalls(f)[0]!.status === 200,
        );
        const original = f.journal.current({ lease: ui.lease })!;
        assert.equal(original.physicallyPending, true);
        await ui.dispose();
        await f.wait(
          () => f.journal.current({ lease: ui.lease })?.phase === "uncertain",
        );
        acknowledge();
        await f.wait(
          () => f.journal.current({ lease: ui.lease })?.phase === "accepted",
        );
        const accepted = f.journal.current({ lease: ui.lease })!;
        const { idempotencyKey: _key, ...originalCommand } = original.input;
        const receipt = parseSelectConceptImageResponse(
          accepted.receipt,
          originalCommand,
        );
        assert.equal(receipt.selection.filename, "second.png");
        assert.equal(receipt.disposition, "committed");
        const restored = await f.mount();
        await f.wait(() => selectedIndex(restored) === "1");
        assert.equal(
          writeCalls(f).length,
          1,
          "late accepted account receipt prevents a second send",
        );
        assert.equal(panel(restored)?.dataset.selectionRevision, "1");
        await noAdditionalExecution(f, before, account);
        await restored.dispose();
      } finally {
        acknowledge();
      }
    },
  );

  test(
    `${backend} source authorization withdrawal before the released selection call preserves UNKNOWN original intent and publishes no selection or charge`,
    options,
    async (t) => {
      if (backend === "postgres")
        assert.ok(process.env.CREWON_TEST_POSTGRES_URL);
      const f = await selectionShortDramaFixture(t, backend, release());
      const before = await f.counts(),
        account = await f.credits.getAccount(f.creditScope);
      const ui = await f.mount();
      await f.wait(() => imageButton(f, ui, 1)?.disabled === false);
      f.state.allowed = false;
      await ui.click(imageButton(f, ui, 1));
      await f.wait(
        () => f.journal.current({ lease: ui.lease })?.phase === "uncertain",
      );
      assert.equal(writeCalls(f).length, 1);
      assert.equal(writeCalls(f)[0]!.status, 403);
      assert.equal(
        f.journal.current({ lease: ui.lease })?.input.resultIndex,
        1,
      );
      assert.deepEqual(
        await f.client.creativeProjects.getConceptSelection({
          projectId: f.reference.projectId,
          assetId: f.reference.assetId,
        }),
        { selectionRevision: 0, current: null },
      );
      await noAdditionalExecution(f, before, account);
      await ui.dispose();
    },
  );

  test(
    `${backend} actual installed source package replacement invalidates the old released ESM mount before it can select`,
    options,
    async (t) => {
      if (backend === "postgres")
        assert.ok(process.env.CREWON_TEST_POSTGRES_URL);
      const f = await selectionShortDramaFixture(t, backend, release());
      const before = await f.counts(),
        account = await f.credits.getAccount(f.creditScope);
      const ui = await f.mount();
      await f.wait(() => imageButton(f, ui, 1)?.disabled === false);
      const current = await f.ledger.loadSelection({
        scope: f.state.profile,
        pluginId: f.installed.descriptor.pluginId,
      });
      assert.ok(current);
      const replacement = await f.files.source(
        "selection-package-replacement",
        {
          pluginId: f.installed.descriptor.pluginId,
          publisherId: f.installed.descriptor.publisherId,
          version: "7.0.1",
          uiOnly: true,
          requiredService: "crewon.project-generation-selections",
        },
      );
      const installed = await installLocalPluginPackage({
        directory: replacement.directory,
        installRoot: f.files.installRoot,
        authorization: async () => ({ outcome: "allow" }),
      });
      const recorded = await f.ledger.recordInstalledPackage(
        installationRecipe("replace-selection-package", {
          scope: f.state.profile,
          actor: f.actor,
          pluginId: installed.descriptor.pluginId,
          publisherId: installed.descriptor.publisherId,
          version: installed.descriptor.version,
          packageDigest: installed.packageDigest,
          expectedSelectionRevision: current.revision,
        }),
      );
      await f.ledger.commitSelection(
        selectionRecipe(
          recorded.selection,
          "activate-selection-package-replacement",
          { actor: f.actor, packageDigest: installed.packageDigest },
        ),
      );
      await ui.click(imageButton(f, ui, 1));
      await f.wait(
        () => f.journal.current({ lease: ui.lease })?.phase === "uncertain",
      );
      assert.equal(writeCalls(f).length, 1);
      assert.notEqual(writeCalls(f)[0]!.status, 200);
      assert.deepEqual(
        await f.client.creativeProjects.getConceptSelection({
          projectId: f.reference.projectId,
          assetId: f.reference.assetId,
        }),
        { selectionRevision: 0, current: null },
      );
      await noAdditionalExecution(f, before, account);
      await ui.dispose();
    },
  );
}
