import { ControlApiClient } from "@crewon/control-client";
import {
  PLUGIN_UI_RECOVERY_VERSION,
  PROJECT_GENERATION_UI_ACTIONS,
  PROJECT_GENERATION_QUERY_UI_ACTIONS,
  PROJECT_GENERATION_SELECTION_UI_ACTIONS,
  parsePluginUiLease,
  parsePluginUiRecoveryHint,
  parsePluginUiRecoveryRequest,
  type PluginUiRecoveryHint,
  type PluginUiRecoveryRequest,
} from "@crewon/contracts/plugins";
import { vi } from "vitest";
import { createControlPluginUiHost } from "./controlPluginUiHost";
import { createDesktopPluginUiHost } from "./desktopPluginUiHost";
import { createInstalledPluginGenerationJournal } from "./installedPluginGenerationJournal";
import { createInstalledPluginProjectQueryJournal } from "./installedPluginProjectQueryJournal";
import { createInstalledPluginProjectSelectionJournal } from "./installedPluginProjectSelectionJournal";
import {
  DESKTOP_PLUGIN_UI_VERSION,
  desktopPluginUiAssetUrl,
} from "../desktop/desktopPluginUiProtocol";
import {
  generationJournalInput,
  generationJournalReceipt,
} from "./installedPluginGenerationJournal.test-support";
import {
  queryJournalInput,
  queryJournalReceipt,
} from "./installedPluginProjectQuery.test-support";
import {
  selectionJournalLease,
  selectionJournalInput,
  selectionJournalReceipt,
} from "./installedPluginProjectSelection.test-support";
import {
  controlUiItem,
  controlUiResponse,
} from "./controlPluginUi.test-support";
import { uiHarness, uiProps } from "./pluginUiLoader.test-support";
import { taskContextThread } from "./installedPluginTaskContext.test-support";

export function recoveryLease(enabled = true, revision = 1) {
  const lease = selectionJournalLease();
  return parsePluginUiLease({
    ...lease,
    selectionRevision: revision,
    descriptor: {
      ...lease.descriptor,
      requires: [
        ...lease.descriptor.requires,
        {
          service: "crewon.project-generation-contexts",
          apiVersion: "1",
          optional: true,
        },
        ...(enabled
          ? [
              {
                service: "crewon.plugin-ui-recovery",
                apiVersion: "1",
                optional: true,
              },
            ]
          : []),
      ],
    },
  });
}
function capture<R extends PluginUiRecoveryRequest>(request: R): R {
  return parsePluginUiRecoveryRequest(request) as R;
}
export const recoveryRequests = [
  capture({
    action: PROJECT_GENERATION_UI_ACTIONS[0],
    input: generationJournalInput(),
  }),
  capture({
    action: PROJECT_GENERATION_QUERY_UI_ACTIONS[0],
    input: queryJournalInput(),
  }),
  capture({
    action: PROJECT_GENERATION_SELECTION_UI_ACTIONS[1],
    input: selectionJournalInput(),
  }),
] as const;
export function recoveryReceipt(request: PluginUiRecoveryRequest) {
  switch (request.action) {
    case PROJECT_GENERATION_UI_ACTIONS[0]:
      return generationJournalReceipt(request.input);
    case PROJECT_GENERATION_QUERY_UI_ACTIONS[0]:
      return queryJournalReceipt(request.input);
    case PROJECT_GENERATION_SELECTION_UI_ACTIONS[1]:
      return selectionJournalReceipt(request.input);
    default:
      throw new Error("legacy_recovery_fixture_action_unsupported");
  }
}
export function recoveryHint(
  request: PluginUiRecoveryRequest = recoveryRequests[0],
  phase: PluginUiRecoveryHint["phase"] = "prepared",
  overrides: Partial<PluginUiRecoveryHint> = {},
): PluginUiRecoveryHint {
  const lease = recoveryLease();
  const count = phase === "prepared" ? 0 : 1;
  return parsePluginUiRecoveryHint({
    sourcePin: {
      pluginId: lease.descriptor.pluginId,
      publisherId: lease.descriptor.publisherId,
      version: lease.descriptor.version,
      packageDigest: lease.packageDigest,
      selectionRevision: lease.selectionRevision,
      contributionId: lease.contributionId,
    },
    request,
    phase,
    revision: count + 1,
    dispatchMayHaveOccurred: count > 0,
    dispatchAttemptCount: count,
    retryable: phase === "prepared" || phase === "dispatched",
    receipt: phase === "accepted" ? recoveryReceipt(request) : null,
    reasonCode:
      phase === "refused" ? "concept_selection_revision_conflict" : null,
    ...overrides,
  });
}
export const recoveryResponse = (intents: readonly PluginUiRecoveryHint[]) => ({
  version: PLUGIN_UI_RECOVERY_VERSION,
  intents,
});

/** Real Control client, leases and renderer journals; deterministic HTTP is not SQL durability proof. */
export function recoveryHostFixture(native = false, enabled = true) {
  if (native) vi.stubGlobal("location", { protocol: "file:", origin: "null" });
  let lease = recoveryLease(enabled);
  let current = true;
  let hints: readonly PluginUiRecoveryHint[] = [];
  let read: (() => Response | Promise<Response>) | undefined;
  let stage:
    | ((request: PluginUiRecoveryRequest) => Response | Promise<Response>)
    | undefined;
  let business:
    | ((request: PluginUiRecoveryRequest) => Response | Promise<Response>)
    | undefined;
  const assertCurrent = vi.fn(() => {
    if (!current) throw new Error("recovery_account_changed");
  });
  const onDiagnostic = vi.fn();
  const generationJournal = createInstalledPluginGenerationJournal({
    assertCurrent,
    onDiagnostic,
  });
  const projectQueryJournal = createInstalledPluginProjectQueryJournal({
    assertCurrent,
    onDiagnostic,
  });
  const selectionJournal = createInstalledPluginProjectSelectionJournal({
    assertCurrent,
    onDiagnostic,
  });
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/recovery")) {
      if (init?.method === "GET")
        return read?.() ?? controlUiResponse(recoveryResponse(hints));
      const request = parsePluginUiRecoveryRequest(
        JSON.parse(String(init?.body)),
      );
      return (
        stage?.(request) ??
        controlUiResponse({
          version: PLUGIN_UI_RECOVERY_VERSION,
          disposition: "created",
          intent: recoveryHint(request),
        })
      );
    }
    if (path.endsWith("/actions")) {
      const request = parsePluginUiRecoveryRequest(
        JSON.parse(String(init?.body)),
      );
      return (
        business?.(request) ??
        controlUiResponse({ output: recoveryReceipt(request) })
      );
    }
    if (path.startsWith("/api/v1/threads/")) {
      const threadId = path.slice("/api/v1/threads/".length);
      const thread = taskContextThread(
        threadId,
        threadId === "original-thread" ? 1 : 17,
      );
      return controlUiResponse({ thread, eventSequence: thread.revision });
    }
    return controlUiResponse(
      init?.method === "DELETE" ? { closed: true } : lease,
    );
  });
  const client = new ControlApiClient({
    baseUrl: native ? "http://127.0.0.1:32100" : location.origin,
    accessToken: "named-recovery-session",
    csrfToken: "named-recovery-csrf",
    fetch,
  });
  const h = uiHarness();
  const importer = vi.fn(async () => ({ default: h.definition }));
  const binding = {
    bindingRef: "c".repeat(64),
    entryUrl: desktopPluginUiAssetUrl("c".repeat(64), "ui/index.js"),
    controlOrigin: client.requestOrigin,
  };
  const assets = {
    version: DESKTOP_PLUGIN_UI_VERSION,
    adopt: vi.fn(async () => binding),
    release: vi.fn(async () => undefined),
    invalidate: vi.fn(async () => undefined),
  };
  const options = {
    client,
    assertCurrent,
    onDiagnostic,
    importer,
    generationJournal,
    projectQueryJournal,
    selectionJournal,
  };
  const host = native
    ? createDesktopPluginUiHost({ ...options, assets })
    : createControlPluginUiHost(options);
  const wire = (ending: string) =>
    fetch.mock.calls.filter(([url]) =>
      new URL(String(url)).pathname.endsWith(ending),
    );
  return {
    client,
    fetch,
    host,
    h,
    importer,
    assets,
    assertCurrent,
    onDiagnostic,
    generationJournal,
    projectQueryJournal,
    selectionJournal,
    journals: [
      generationJournal,
      projectQueryJournal,
      selectionJournal,
    ] as const,
    get lease() {
      return lease;
    },
    setLease(value: typeof lease) {
      lease = value;
    },
    setHints(value: readonly PluginUiRecoveryHint[]) {
      hints = value;
    },
    setRead(value: typeof read) {
      read = value;
    },
    setStage(value: typeof stage) {
      stage = value;
    },
    setBusiness(value: typeof business) {
      business = value;
    },
    revoke() {
      current = false;
      for (const journal of this.journals) journal.invalidate();
    },
    wire,
    acquire(signal = new AbortController().signal) {
      return host.acquireMount(controlUiItem(lease), "workbench", signal);
    },
    async mount() {
      const acquired = await this.acquire();
      return host.loader.mount({
        root: h.root,
        lease: acquired,
        props: uiProps(),
      });
    },
  };
}
