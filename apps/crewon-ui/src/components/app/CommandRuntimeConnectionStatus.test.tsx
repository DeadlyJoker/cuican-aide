// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandRuntimeConnectionStatus } from "./CommandRuntimeConnectionStatus";
import {
  DESKTOP_PROVIDER_CHANGED_EVENT,
  providerCredentialStore,
  type ProviderCredentialCatalog,
} from "../../lib/model-provider/providerCredentialStore";

vi.mock("../../lib/model-provider/providerCredentialStore", () => ({
  providerCredentialStore: vi.fn(),
  DESKTOP_PROVIDER_CHANGED_EVENT: "crewon:desktop-provider-changed",
}));
const empty: ProviderCredentialCatalog = {
  activeProviderId: null,
  bindings: [],
};
const configured: ProviderCredentialCatalog = {
  activeProviderId: "example",
  bindings: [
    {
      providerId: "example",
      endpoint: "https://models.example.com/v1",
      modelId: "example-model",
      credentialAvailable: true,
      credentialKind: "keychain",
      environmentVariable: null,
      isActive: true,
    },
  ],
};
let container: HTMLDivElement;
let root: Root;
const catalog = vi.fn<() => Promise<ProviderCredentialCatalog>>();
const onConfigureModel = vi.fn();
const onReconnect = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  catalog.mockReset().mockResolvedValue(empty);
  onConfigureModel.mockClear();
  onReconnect.mockClear();
  vi.mocked(providerCredentialStore).mockReturnValue({
    catalog,
  } as unknown as NonNullable<ReturnType<typeof providerCredentialStore>>);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(
  connectionState: "connected" | "disconnected" = "disconnected",
) {
  await act(async () =>
    root.render(
      <CommandRuntimeConnectionStatus
        connectionState={connectionState}
        locale="zh"
        onConfigureModel={onConfigureModel}
        onReconnect={onReconnect}
      />,
    ),
  );
}

describe("desktop task service setup guidance", () => {
  it("opens model settings when a fresh installation has no model configured", async () => {
    await render();
    expect(container.innerHTML).toMatchSnapshot();
    expect(container.textContent).toContain("先配置 AI 模型，即可开始任务");
    expect(container.textContent).not.toContain("重新连接");
    expect(container.querySelector(".connection-indicator")).toBeNull();
    await act(async () => container.querySelector("button")!.click());
    expect(onConfigureModel).toHaveBeenCalledOnce();
    expect(onReconnect).not.toHaveBeenCalled();
  });
  it("guides setup when the saved model credential is unavailable", async () => {
    catalog.mockResolvedValue({
      ...configured,
      bindings: [{ ...configured.bindings[0]!, credentialAvailable: false }],
    });
    await render();
    expect(container.textContent).toContain("配置 AI 模型");
  });
  it("keeps reconnect for an actual service failure with a configured model", async () => {
    catalog.mockResolvedValue(configured);
    await render();
    expect(container.textContent).toBe("重新连接");
    await act(async () => container.querySelector("button")!.click());
    expect(onReconnect).toHaveBeenCalledOnce();
  });
  it("does not classify a failed provider catalog request as missing configuration", async () => {
    catalog.mockRejectedValue(new Error("IPC unavailable"));
    await render();
    expect(container.textContent).toBe("重新连接");
  });
  it("refreshes setup guidance after model settings change", async () => {
    await render();
    catalog.mockResolvedValue(configured);
    await act(async () =>
      globalThis.dispatchEvent(new Event(DESKTOP_PROVIDER_CHANGED_EVENT)),
    );
    expect(container.textContent).toBe("重新连接");
    await render("connected");
    expect(
      container.querySelector('[role="status"]')?.getAttribute("aria-label"),
    ).toBe("对话服务已连接");
  });
  it("ignores a stale catalog response after a later settings update", async () => {
    let resolveFirst!: (value: ProviderCredentialCatalog) => void;
    catalog.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );
    await render();
    catalog.mockResolvedValue(configured);
    await act(async () =>
      globalThis.dispatchEvent(new Event(DESKTOP_PROVIDER_CHANGED_EVENT)),
    );
    await act(async () => resolveFirst(empty));
    expect(container.textContent).toBe("重新连接");
  });
  it("preserves the web connection state without reading native credentials", async () => {
    vi.mocked(providerCredentialStore).mockReturnValue(null);
    await render();
    expect(container.textContent).toBe("重新连接");
    expect(catalog).not.toHaveBeenCalled();
  });
});
