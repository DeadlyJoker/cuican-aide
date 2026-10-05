// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { PROJECT_CONVERSATIONS_METHOD_ACTIONS } from "@crewon/contracts/project-conversations";
import { PROJECT_CONVERSATION_ASSOCIATION_ACTIONS as association } from "@crewon/contracts/project-conversation-association";
import {
  controlUiClient,
  controlUiResponse,
} from "./controlPluginUi.test-support";
import { deferred, uiLease } from "./pluginUiLoader.test-support";
import { invokeInstalledPluginConversation } from "./installedPluginConversationTransport";
import { subscribeProjectConversationBindingChanges } from "./projectConversationBindingChanges";

const lease = uiLease();
const at = "2026-10-06T00:00:00.000Z";
function binding() {
  return {
    bindingId: "project-binding",
    projectId: "actual-project",
    threadId: "project-thread",
    workspaceId: "original-workspace",
    revision: 1,
    state: "active",
    source: {
      pluginId: lease.descriptor.pluginId,
      publisherId: lease.descriptor.publisherId,
      version: lease.descriptor.version,
      packageDigest: lease.packageDigest,
      selectionRevision: lease.selectionRevision,
    },
    createdAt: at,
    updatedAt: at,
  };
}
function thread() {
  return {
    eventSequence: 3,
    thread: {
      threadId: "project-thread",
      workspaceId: "original-workspace",
      title: "项目创作",
      status: "active",
      revision: 3,
      lastMessageSequence: 2,
      forkedFromThreadId: null,
      forkedThroughHistorySequence: null,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      deletedAt: null,
    },
  };
}
const open = () => ({
  action: PROJECT_CONVERSATIONS_METHOD_ACTIONS.openConversation,
  input: { projectId: "actual-project", threadId: "project-thread" },
  signal: new AbortController().signal,
});

describe("installed project conversation navigation (original authenticated client)", () => {
  it("opens only the explicit canonical bound Thread and retains its original workspace", async () => {
    const onOpen = vi.fn();
    const wire = controlUiClient((url, init) => {
      if (init.method === "POST")
        return controlUiResponse({ output: { binding: binding() } });
      expect(url.pathname).toBe("/api/v1/threads/project-thread");
      return controlUiResponse(thread());
    });
    const result = await invokeInstalledPluginConversation(
      { client: wire.client, assertCurrent() {}, onOpen },
      lease,
      open(),
    );
    expect(result).toEqual({ binding: binding() });
    expect(onOpen).toHaveBeenCalledExactlyOnceWith({
      lease,
      binding: binding(),
    });
    expect(wire.fetch).toHaveBeenCalledTimes(2);
    expect(
      wire.fetch.mock.calls.every(
        ([, init]) =>
          new Headers(init?.headers).get("authorization") ===
          "Bearer captured-user-token",
      ),
    ).toBe(true);
  });

  it("creating a project conversation returns its metadata without automatically navigating or creating a task receipt", async () => {
    const onOpen = vi.fn();
    const wire = controlUiClient(() =>
      controlUiResponse({
        output: { disposition: "committed", binding: binding() },
      }),
    );
    await invokeInstalledPluginConversation(
      { client: wire.client, assertCurrent() {}, onOpen },
      lease,
      {
        action: PROJECT_CONVERSATIONS_METHOD_ACTIONS.createConversation,
        input: {
          projectId: "actual-project",
          workspaceId: "original-workspace",
          title: null,
          idempotencyKey: "original-create-key",
        },
        signal: new AbortController().signal,
      },
    );
    expect(onOpen).not.toHaveBeenCalled();
    expect(wire.fetch).toHaveBeenCalledTimes(1);
  });
  it("association uses the authenticated installed UI invocation and validates the exact source without navigation or execution", async () => {
    const onOpen = vi.fn();
    const changed = vi.fn();
    const wire = controlUiClient(() =>
      controlUiResponse({
        output: { disposition: "committed", binding: binding() },
      }),
    );
    const request = {
      action: association.attach,
      input: {
        projectId: "actual-project",
        threadId: "project-thread",
        workspaceId: "original-workspace",
        expectedThreadRevision: 3,
        idempotencyKey: "association-once",
      },
      signal: new AbortController().signal,
    };
    const unsubscribe = subscribeProjectConversationBindingChanges(
      wire.client,
      "project-thread",
      changed,
    );
    const result = await invokeInstalledPluginConversation(
      { client: wire.client, assertCurrent() {}, onOpen },
      lease,
      request,
    );
    expect(result).toEqual({ disposition: "committed", binding: binding() });
    expect(wire.fetch).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(1);
    unsubscribe();
    const invalid = controlUiClient(() =>
      controlUiResponse({
        output: {
          disposition: "committed",
          binding: {
            ...binding(),
            source: {
              ...binding().source,
              packageDigest: "sha256:" + "f".repeat(64),
            },
          },
        },
      }),
    );
    const invalidChanged = vi.fn();
    const unsubscribeInvalid = subscribeProjectConversationBindingChanges(
      invalid.client,
      "project-thread",
      invalidChanged,
    );
    await expect(
      invokeInstalledPluginConversation(
        { client: invalid.client, assertCurrent() {}, onOpen },
        lease,
        request,
      ),
    ).rejects.toThrow("plugin_ui_project_conversation_source_changed");
    expect(invalidChanged).not.toHaveBeenCalled();
    unsubscribeInvalid();
  });

  it("a canonical binding read after lost association ACK refreshes only an opted-in module's original composer", async () => {
    const changed = vi.fn();
    const wire = controlUiClient(() =>
      controlUiResponse({ output: { binding: binding() } }),
    );
    const unsubscribe = subscribeProjectConversationBindingChanges(
      wire.client,
      "project-thread",
      changed,
    );
    const request = {
      action: PROJECT_CONVERSATIONS_METHOD_ACTIONS.getBinding,
      input: { threadId: "project-thread" },
      signal: new AbortController().signal,
    };
    await invokeInstalledPluginConversation(
      { client: wire.client, assertCurrent() {} },
      lease,
      request,
    );
    expect(changed).not.toHaveBeenCalled();
    const declared = {
      ...lease,
      descriptor: {
        ...lease.descriptor,
        requires: [
          {
            service: "crewon.project-conversation-association",
            apiVersion: "1",
            optional: true,
          },
        ],
      },
    };
    await invokeInstalledPluginConversation(
      { client: wire.client, assertCurrent() {} },
      declared,
      request,
    );
    expect(changed).toHaveBeenCalledTimes(1);
    expect(
      wire.fetch.mock.calls.every(([, init]) => init?.method === "POST"),
    ).toBe(true);
    unsubscribe();
  });

  it("refuses a mismatched package source or canonical workspace without navigation", async () => {
    for (const changed of ["source", "workspace"] as const) {
      const onOpen = vi.fn();
      const wire = controlUiClient((_url, init) =>
        init.method === "POST"
          ? controlUiResponse({
              output: {
                binding: {
                  ...binding(),
                  ...(changed === "source"
                    ? { source: { ...binding().source, selectionRevision: 2 } }
                    : {}),
                },
              },
            })
          : controlUiResponse({
              ...thread(),
              thread: { ...thread().thread, workspaceId: "other-workspace" },
            }),
      );
      await expect(
        invokeInstalledPluginConversation(
          { client: wire.client, assertCurrent() {}, onOpen },
          lease,
          open(),
        ),
      ).rejects.toThrow();
      expect(onOpen).not.toHaveBeenCalled();
      expect(wire.fetch).toHaveBeenCalledTimes(changed === "source" ? 1 : 2);
    }
  });

  it("does not navigate after owner withdrawal while the canonical Thread request is physically pending", async () => {
    let current = true;
    const late = deferred<Response>();
    const onOpen = vi.fn();
    const wire = controlUiClient((_url, init) =>
      init.method === "POST"
        ? controlUiResponse({ output: { binding: binding() } })
        : late.promise,
    );
    const call = invokeInstalledPluginConversation(
      {
        client: wire.client,
        assertCurrent() {
          if (!current) throw new Error("owner_withdrawn");
        },
        onOpen,
      },
      lease,
      open(),
    );
    while (wire.fetch.mock.calls.length < 2)
      await new Promise((resolve) => setTimeout(resolve, 0));
    current = false;
    late.resolve(controlUiResponse(thread()));
    await expect(call).rejects.toThrow("owner_withdrawn");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("unknown namespace methods and unavailable navigation fail before HTTP", async () => {
    const wire = controlUiClient(() => {
      throw new Error("unexpected_http");
    });
    const options = { client: wire.client, assertCurrent() {} };
    await expect(
      invokeInstalledPluginConversation(options, lease, {
        ...open(),
        action: "crewon.project-conversations.v1.unknown",
      }),
    ).rejects.toThrow();
    await expect(
      invokeInstalledPluginConversation(options, lease, open()),
    ).rejects.toThrow("plugin_ui_project_conversation_navigation_unavailable");
    expect(wire.fetch).not.toHaveBeenCalled();
  });
});
