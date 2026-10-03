import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import Fastify from "fastify";
import {
  PluginUiApplicationService,
  PluginUiRecoveryApplicationService,
  createPluginUiIntentPayloadVerifier,
  type ActorContext,
  type PluginUiActionContext,
} from "@crewon/application";
import { ControlApiClient } from "@crewon/control-client";
import {
  parsePluginUiRecoveryRequest,
  type PluginUiRecoveryRequest,
} from "@crewon/contracts";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import { type PluginProfileScope } from "@crewon/domain";
import {
  installationRecipe,
  selectionRecipe,
} from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import { extensionStoreDigester as digester } from "../../../packages/store/src/extension-store-records.ts";
import { timestamp } from "../../../packages/store/src/extension-store.test-support.ts";
import { conceptSelectionHttpFixture } from "./project-generation-selection-route.test-support.ts";
import { ProjectGenerationSelectionPluginUiOwner } from "./project-generation-selection-plugin-ui-owner.ts";
import { registerPluginControlRoutes } from "./plugin-control-route.ts";
import { errorResponse } from "./control-api-errors.ts";

export const recoverySelectionAction =
  "crewon.project-generation-selections.v1.selectConceptImage" as const;
export type SelectionRecoveryRequest = Extract<
  PluginUiRecoveryRequest,
  { action: typeof recoverySelectionAction }
>;
/** Real SQL selection owner + registered HTTP + original opaque receipt issuer. Package verification, identity/profile/PDP and paid wallet/history are explicitly named fixtures. */
export async function selectionRecoveryHttpFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const history = await conceptSelectionHttpFixture(t, backend);
  const profile: PluginProfileScope = {
    tenantId: history.actor.tenantId,
    spaceId: history.actor.spaceId,
    profileId: history.enabled.selection.profileId,
  };
  const ledger = history.first.parent.pluginInstallationStore();
  const recipe = installationRecipe("recovery-ui-source", {
    scope: profile,
    actor: history.actor,
    pluginId: "example.recovery-selection",
    version: "8.0.0",
    at: timestamp,
  });
  const installed = await ledger.recordInstalledPackage(recipe),
    selected = await ledger.commitSelection(
      selectionRecipe(installed.selection, "recovery-ui-enabled", {
        actor: history.actor,
        at: timestamp,
      }),
    );
  const descriptor = parsePluginPackageDescriptor({
    schemaVersion: "crewon.plugin-package.v1",
    hostApi: "crewon.plugin-host.v1",
    pluginId: recipe.package.pluginId,
    publisherId: recipe.package.publisherId,
    version: recipe.package.version,
    title: "Selection recovery fixture",
    description: "Explicit test byte verifier and identity/profile/PDP ports",
    entrypoints: { node: null, ui: { path: "ui.mjs", mode: "trustedModule" } },
    businessManifestPath: null,
    requires: [
      {
        service: "crewon.project-generation-selections",
        apiVersion: "1",
        optional: true,
      },
      {
        service: "crewon.plugin-ui-recovery",
        apiVersion: "1",
        optional: false,
      },
    ],
    provides: [],
    contributions: [
      {
        id: "workbench",
        kind: "module",
        slot: "main.content",
        title: "Selection",
      },
    ],
    files: [{ path: "ui.mjs", byteLength: 1, sha256: "a".repeat(64) }],
  });
  const publication = {
    pluginId: recipe.package.pluginId,
    packageDigest: recipe.package.packageDigest,
    contributionId: "workbench",
  };
  const state = {
    actor: { ...history.actor } as ActorContext,
    profile: { ...profile },
    allowed: true,
    epoch: "recovery-fixture-epoch-1",
    selectionInvocations: 0,
    readInvocations: 0,
    context: null as PluginUiActionContext | null,
    dropStageAck: false,
    dropInvokeAck: false,
    beforeOwnerAuthorize: null as (() => Promise<void>) | null,
    afterOutcome: null as (() => Promise<void>) | null,
    diagnostics: [] as unknown[],
    physical: [] as { method: string; path: string; body: unknown }[],
  };
  const sessions: { close(): Promise<void> }[] = [];
  async function open() {
    const journal = history.first.parent.pluginUiIntentJournalStore({
      verifier: createPluginUiIntentPayloadVerifier(digester),
    });
    await journal.migratePluginUiIntentJournal();
    const recovery = new PluginUiRecoveryApplicationService({
      store: journal,
      publications: [{ ...publication, actions: [recoverySelectionAction] }],
      clock: { now: () => timestamp },
      digester,
      onDiagnostic: (error) => state.diagnostics.push(error),
    });
    const owner = new ProjectGenerationSelectionPluginUiOwner({
      configuration: { publications: [publication] },
      selections: history.selectionService,
      authorization: {
        authorize: async () => {
          await state.beforeOwnerAuthorize?.();
          if (!state.allowed)
            throw new Error("recovery-selection-source-withdrawn");
        },
      },
    });
    const ui = new PluginUiApplicationService({
      store: ledger,
      profiles: { resolve: async () => ({ ...state.profile }) },
      authorization: {
        authorize: async () =>
          state.allowed
            ? { outcome: "allow", authorityEpoch: state.epoch }
            : { outcome: "deny", reasonCode: "recovery-fixture-denied" },
      },
      packages: {
        verify: async () => ({ descriptor, publicAssets: ["ui.mjs"] }),
        readAsset: async () => ({
          bytes: new Uint8Array([1]),
          contentType: "text/javascript",
        }),
      },
      clock: { now: () => timestamp },
      ids: { nextId: () => randomUUID().replaceAll("-", "") },
      actions: {
        invoke: async (context) => {
          state.context = context;
          if (context.action === recoverySelectionAction)
            state.selectionInvocations++;
          else state.readInvocations++;
          const result = await owner.actions.invoke(context);
          const after = state.afterOutcome;
          if (after) {
            state.afterOutcome = null;
            await after();
          }
          return result;
        },
      },
      committedMetadata: owner.committedMetadata,
      recovery,
    });
    const app = Fastify();
    app.setErrorHandler((error, request, reply) => {
      const response = errorResponse(error, request.id);
      return reply.code(response.statusCode).send(response.body);
    });
    registerPluginControlRoutes(app, {
      identity: {
        resolveActor: async (request) => {
          await history.selectionIdentity.resolveActor(request);
          return { ...state.actor };
        },
      },
      pluginUi: ui,
    });
    const headers = history.selectionHeaders();
    const fetch: typeof globalThis.fetch = async (url, init = {}) => {
      init.signal?.throwIfAborted();
      const path = new URL(String(url)).pathname + new URL(String(url)).search,
        method = init.method ?? "GET",
        body =
          typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      state.physical.push({ method, path, body });
      const requestHeaders: Record<string, string> = {};
      new Headers(init.headers).forEach((value, key) => {
        requestHeaders[key] = value;
      });
      const response = await app.inject({
        method: method as "GET" | "POST" | "DELETE" | "PUT",
        url: path,
        headers: requestHeaders,
        ...(body === undefined ? {} : { payload: body }),
      });
      if (
        method === "POST" &&
        path.endsWith("/recovery") &&
        state.dropStageAck
      ) {
        state.dropStageAck = false;
        throw new TypeError("lost-durable-stage-ack");
      }
      if (
        method === "POST" &&
        path.endsWith("/actions") &&
        state.dropInvokeAck
      ) {
        state.dropInvokeAck = false;
        throw new TypeError("lost-original-selection-ack");
      }
      return new Response(response.body, {
        status: response.statusCode,
        headers: response.headers as Record<string, string>,
      });
    };
    const client = new ControlApiClient({
      baseUrl: "https://recovery-control.fixture",
      accessToken: headers.authorization.slice("Bearer ".length),
      origin: headers.origin,
      csrfToken: headers["x-csrf-token"],
      fetch,
    });
    const mounts: string[] = [];
    const mount = async () => {
      const current = await ledger.loadSelection({
        scope: state.profile,
        pluginId: recipe.package.pluginId,
      });
      assert.ok(current);
      const lease = await client.plugins.openMount({
        pluginId: recipe.package.pluginId,
        contributionId: "workbench",
        expectedSelectionRevision: current.revision,
        expectedPackageDigest: recipe.package.packageDigest,
      });
      mounts.push(lease.mountRef);
      return lease;
    };
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      for (const mountRef of mounts)
        await ui.closeMount(state.actor, { mountRef }).catch(() => {});
      await owner.close();
      await app.close();
    };
    const result = { app, ui, owner, journal, recovery, client, mount, close };
    sessions.push(result);
    return result;
  }
  t.after(async () => {
    for (const session of sessions) await session.close();
  });
  const request = (
    key = "original-recovery-selection",
    resultIndex = 0,
    expectedSelectionRevision = 0,
  ): SelectionRecoveryRequest =>
    parsePluginUiRecoveryRequest({
      action: recoverySelectionAction,
      input: {
        ...history.selectionBody(resultIndex, expectedSelectionRevision),
        idempotencyKey: key,
      },
    }) as SelectionRecoveryRequest;
  const current = async () => {
    const response = await history.app.inject({
      url: history.selectionUrl,
      headers: history.selectionHeaders(),
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const taskEffects = async () => ({
    counts: await history.counts(),
    wallet: await history.credits.getAccount(history.creditScope),
    hostCalls: history.policy.hostCalls,
  });
  const selectionReceiptCount = () =>
    history.count("creative_concept_selection_receipts");
  const failConfirmationStorage = async (enabled: boolean) => {
    const name = "recovery_confirm_fixture_failure";
    if (backend === "sqlite")
      await history.sql(
        enabled
          ? `CREATE TRIGGER ${name} BEFORE UPDATE ON plugin_ui_intents WHEN NEW.phase='accepted' BEGIN SELECT RAISE(ABORT,'recovery-confirm-storage-failed'); END;`
          : `DROP TRIGGER ${name};`,
      );
    else
      await history.sql(
        enabled
          ? `CREATE FUNCTION ${history.prefix}${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'recovery-confirm-storage-failed'; END $$; CREATE TRIGGER ${name} BEFORE UPDATE ON ${history.prefix}plugin_ui_intents FOR EACH ROW WHEN (NEW.phase='accepted') EXECUTE FUNCTION ${history.prefix}${name}();`
          : `DROP TRIGGER ${name} ON ${history.prefix}plugin_ui_intents;DROP FUNCTION ${history.prefix}${name}();`,
      );
  };
  const installProfile = async (nextProfile: PluginProfileScope) => {
    const next = await ledger.recordInstalledPackage(
      installationRecipe(`recovery-other-profile-${randomUUID()}`, {
        scope: nextProfile,
        actor: history.actor,
        pluginId: recipe.package.pluginId,
        version: recipe.package.version,
        at: timestamp,
      }),
    );
    return ledger.commitSelection(
      selectionRecipe(next.selection, `recovery-other-enable-${randomUUID()}`, {
        actor: history.actor,
        at: timestamp,
      }),
    );
  };
  return {
    ...history,
    ledger,
    descriptor,
    selected,
    publication,
    state,
    open,
    request,
    current,
    taskEffects,
    selectionReceiptCount,
    failConfirmationStorage,
    installProfile,
  };
}
