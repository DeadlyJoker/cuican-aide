// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GetExtensionActivationResponse,
  GetExtensionConfigurationResponse,
} from "@crewon/contracts";

import {
  BusinessExtensionPanel,
  extensionBaseUrlValid,
  extensionResultUrl,
  type BusinessExtensionPanelProps,
  type ExtensionOperationProjection,
  type ExtensionTaskProjection,
} from "./BusinessExtensionPanel";

type ExtensionActivation = NonNullable<
  GetExtensionActivationResponse["activation"]
>;
type ExtensionConfiguration = NonNullable<
  GetExtensionConfigurationResponse["configuration"]
>;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const digest = `sha256:${"a".repeat(64)}`;
const configuration: ExtensionConfiguration = {
  schemaVersion: "crewon.extension-configuration.v0",
  tenantId: "tenant",
  spaceId: "space",
  pluginId: "crewon.comfyui-krea2",
  revision: 1,
  pluginVersion: "0.1.0",
  manifestDigest: digest,
  implementationDigest: digest,
  parameters: { baseUrl: "https://comfyui.example.com/" },
  credentialBindings: [],
  createdByActorId: "actor",
  createdAt: "2026-10-01T00:00:00.000Z",
  contentDigest: digest,
};
const activation: ExtensionActivation = {
  schemaVersion: "crewon.extension-activation.v0",
  tenantId: "tenant",
  spaceId: "space",
  pluginId: configuration.pluginId,
  revision: 1,
  configurationRevision: 1,
  configurationDigest: digest,
  state: "enabled",
  target: {
    executionAuthority: "crewonKernel",
    agentVersionId: "comfy-agent",
    agentVersionContentDigest: digest,
    materializationDigest: digest,
    authorityId: "authority",
    runtimeGeneration: "ts-v0",
    policySnapshotId: "policy",
    workspaceBindingId: null,
  },
  updatedByActorId: "actor",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const operation: ExtensionOperationProjection = {
  sourceRunId: "original-generation-run",
  operationId: "operation-id",
  status: "unknownOutcome",
  images: [],
};
const task: ExtensionTaskProjection = {
  runId: "query-run",
  configurationRevision: 1,
  runStatus: "completed",
  operations: [operation],
};

function props(
  patch: Partial<BusinessExtensionPanelProps> = {},
): BusinessExtensionPanelProps {
  return {
    locale: "en",
    title: "Krea2 image generation",
    description: "Generate an image through the configured ComfyUI service.",
    phase: "ready",
    configuration,
    activation,
    baseUrl: "https://comfyui.example.com/",
    onBaseUrlChange: vi.fn(),
    agentVersions: [
      { agentVersionId: "comfy-agent", label: "Image Agent", available: true },
    ],
    selectedAgentVersionId: "comfy-agent",
    selectedAgentReady: true,
    onAgentVersionChange: vi.fn(),
    prompt: "A ceramic teapot on a sunlit table.",
    onPromptChange: vi.fn(),
    tasks: [],
    busy: null,
    error: null,
    onSave: vi.fn(),
    onEnable: vi.fn(),
    onDisable: vi.fn(),
    onGenerate: vi.fn(),
    onQuery: vi.fn(),
    onRefresh: vi.fn(),
    onOpenRun: vi.fn(),
    ...patch,
  };
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function mount(initial: BusinessExtensionPanelProps) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (next: BusinessExtensionPanelProps) => {
    await act(async () => root.render(<BusinessExtensionPanel {...next} />));
  };
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await render(initial);
  const button = (label: string) => {
    const target = [...container.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === label,
    );
    expect(target, label).toBeDefined();
    return target!;
  };
  const click = async (label: string) => {
    await act(async () => button(label).click());
  };
  return { container, render, button, click };
}

describe("BusinessExtensionPanel", () => {
  it.each([
    { baseUrl: "https://different.example.com/" },
    { selectedAgentVersionId: "different-agent" },
    { selectedAgentReady: false },
  ])(
    "blocks fresh generation with unapplied settings or unready selection: %j",
    async (patch) => {
      const state = props(patch);
      const f = await mount(state);
      expect(f.button("Generate image").disabled).toBe(true);
      await f.click("Generate image");
      expect(state.onGenerate).not.toHaveBeenCalled();
    },
  );

  it("preserves same-submission recovery when current settings differ from the frozen task", async () => {
    const state = props({
      pendingTask: "retrySubmission",
      baseUrl: "https://different.example.com/",
      selectedAgentVersionId: "different-agent",
      selectedAgentReady: false,
    });
    const f = await mount(state);
    await f.click("Retry the same submission");
    expect(state.onGenerate).toHaveBeenCalledTimes(1);
    expect(f.button("Save configuration").disabled).toBe(true);
  });

  it("snapshots saved configuration without inventing an available execution Agent", () => {
    const markup = renderToStaticMarkup(
      <BusinessExtensionPanel
        {...props({
          locale: "zh",
          title: "Krea2 生图",
          description: "通过已配置的 ComfyUI 服务生成写实图片。",
          activation: null,
          agentVersions: [],
          selectedAgentVersionId: null,
          selectedAgentReady: false,
        })}
      />,
    );
    expect(markup).toContain("已保存 · 版本 1");
    expect(markup).toContain("暂无可用的生图 Agent");
    expect(markup).toContain("保存配置");
    expect(markup).toContain("启用插件");
    expect(markup).not.toContain("Runtime 就绪");
    expect(markup).toMatchSnapshot();
  });
  it("snapshots authoritative outcomes and separate conversation state in English", () => {
    const markup = renderToStaticMarkup(
      <BusinessExtensionPanel
        {...props({
          tasks: [
            task,
            {
              ...task,
              runId: "successful-run",
              operations: [
                {
                  ...operation,
                  sourceRunId: "successful-run",
                  status: "succeeded",
                  images: [
                    {
                      filename: "teapot.png",
                      url: "https://comfyui.example.com/view?filename=teapot.png&type=output",
                    },
                  ],
                },
              ],
              truncated: true,
            },
          ],
        })}
      />,
    );
    expect(markup).toContain("Conversation completed");
    expect(markup).toContain("External outcome unconfirmed");
    expect(markup).toContain("Generation confirmed by the service");
    expect(markup).toContain("Only part of the operation history");
    expect(markup).toMatchSnapshot();
  });
  it("saving a configuration does not enable the plugin or create a task", async () => {
    const p = props({ configuration: null, activation: null });
    const f = await mount(p);
    await f.click("Save configuration");
    expect(p.onSave).toHaveBeenCalledExactlyOnceWith();
    expect(f.button("Enable plugin").disabled).toBe(true);
    expect(f.button("Generate image").disabled).toBe(true);
    expect(p.onEnable).not.toHaveBeenCalled();
    expect(p.onGenerate).not.toHaveBeenCalled();
  });
  it("requires actual selected-version readiness even when a deployed option exists", async () => {
    const p = props({
      selectedAgentReady: false,
      readyReason: "Execution unavailable for this configuration.",
    });
    const f = await mount(p);
    await f.click("Enable plugin");
    expect(p.onEnable).not.toHaveBeenCalled();
    expect(f.container.textContent).toContain(p.readyReason);
    await f.render({ ...p, selectedAgentReady: true });
    await f.click("Enable plugin");
    expect(p.onEnable).toHaveBeenCalledExactlyOnceWith("comfy-agent");
    expect(p.onSave).not.toHaveBeenCalled();
  });
  it("keeps edited inputs and selected versions controlled by the caller", async () => {
    const p = props();
    const f = await mount(p);
    const input = f.container.querySelector("input")!;
    const textarea = f.container.querySelector("textarea")!;
    const select = f.container.querySelector("select")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "https://new-service.example.com/");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(textarea, "A glass vase");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(p.onBaseUrlChange).toHaveBeenCalledWith(
      "https://new-service.example.com/",
    );
    expect(p.onPromptChange).toHaveBeenCalledWith("A glass vase");
    expect(p.onAgentVersionChange).toHaveBeenCalledWith(null);
    expect(p.onGenerate).not.toHaveBeenCalled();
  });
  it("separates the saved revision from the enabled revision and blocks new generation on mismatch", async () => {
    const p = props({
      configuration: {
        ...configuration,
        revision: 2,
        contentDigest: `sha256:${"b".repeat(64)}`,
      },
    });
    const f = await mount(p);
    expect(f.container.textContent).toContain("Saved · revision 2");
    expect(f.container.textContent).toContain("Uses configuration revision 1");
    expect(f.container.textContent).toContain("Enable it again");
    await f.click("Generate image");
    expect(p.onGenerate).not.toHaveBeenCalled();
    expect(f.button("Enable plugin").disabled).toBe(false);
  });
  it("does not infer image success from a completed conversation without an operation", () => {
    const markup = renderToStaticMarkup(
      <BusinessExtensionPanel
        {...props({ tasks: [{ ...task, operations: [] }] })}
      />,
    );
    expect(markup).toContain("Conversation completed");
    expect(markup).toContain("Image generation is unconfirmed");
    expect(markup).not.toContain("Generation confirmed by the service");
    expect(markup).not.toContain("href=");
  });
  it("queries an unknown outcome using the original operation owner even from a later query Run", async () => {
    const p = props({ tasks: [task] });
    const f = await mount(p);
    expect(f.container.textContent).toContain("may have been accepted");
    await f.click("Query source task result");
    expect(p.onQuery).toHaveBeenCalledExactlyOnceWith({
      sourceRunId: "original-generation-run",
      operationId: "operation-id",
    });
    expect(p.onGenerate).not.toHaveBeenCalled();
    await f.click("Open task conversation");
    expect(p.onOpenRun).toHaveBeenCalledExactlyOnceWith("query-run");
  });
  it("permits read-only source queries after disabling but blocks them after revocation", async () => {
    const p = props({
      activation: { ...activation, state: "disabled", target: null },
      tasks: [task],
    });
    const f = await mount(p);
    expect(f.button("Generate image").disabled).toBe(true);
    expect(f.button("Query source task result").disabled).toBe(false);
    await f.render({
      ...p,
      activation: { ...activation, state: "revoked", target: null },
    });
    expect(f.button("Query source task result").disabled).toBe(true);
  });
  it("exposes only controlled HTTPS links for service-confirmed images without fetching remote media", () => {
    const images = [
      {
        filename: "image.png",
        url: "https://comfyui.example.com/view?filename=image.png",
      },
      ...[
        "javascript:alert(1)",
        "http://comfyui.example.com/view",
        "https://user:secret@comfyui.example.com/view",
        "data:image/png,abc",
      ].map((url) => ({ filename: "unsafe.png", url })),
    ];
    const markup = renderToStaticMarkup(
      <BusinessExtensionPanel
        {...props({
          tasks: [
            {
              ...task,
              operations: [{ ...operation, status: "succeeded", images }],
            },
          ],
        })}
      />,
    );
    expect(markup.match(/<a /g)).toHaveLength(1);
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain("Result link unavailable");
    expect(markup).not.toContain("secret@");
    expect(markup).not.toContain("javascript:");
    expect(markup).not.toContain("<img");
    const pending = renderToStaticMarkup(
      <BusinessExtensionPanel
        {...props({
          tasks: [
            {
              ...task,
              operations: [{ ...operation, status: "running", images }],
            },
          ],
        })}
      />,
    );
    expect(pending).not.toContain("<a ");
  });
  it("keeps failures, empty successful results, and unavailable reads honest", () => {
    const markup = renderToStaticMarkup(
      <BusinessExtensionPanel
        {...props({
          phase: "unavailable",
          unavailableReason: "Service state could not be read.",
          error: "Please retry status read.",
          tasks: [
            {
              ...task,
              runStatus: "failed",
              failureCode: "provider_unavailable",
              operations: [
                { ...operation, status: "failed" },
                {
                  ...operation,
                  operationId: "empty-success",
                  status: "succeeded",
                },
              ],
            },
          ],
        })}
      />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Conversation failed");
    expect(markup).toContain("External generation failed");
    expect(markup).toContain("no image link is available");
    expect(markup).toContain("Service state could not be read");
    expect(markup).not.toContain("<a ");
  });
  it("blocks writes during pending mutations and lets unavailable reads retry without issuing writes", async () => {
    const p = props({ busy: "generating", tasks: [task] });
    const f = await mount(p);
    expect(
      [...f.container.querySelectorAll("input,select,textarea")].every(
        (field) => (field as HTMLInputElement).disabled,
      ),
    ).toBe(true);
    expect(
      [...f.container.querySelectorAll("button")]
        .filter((button) => button.textContent !== "Open task conversation")
        .every((button) => button.disabled),
    ).toBe(true);
    await f.render({ ...p, busy: null, phase: "unavailable" });
    await f.click("Refresh status");
    expect(p.onRefresh).toHaveBeenCalledExactlyOnceWith();
    await f.click("Enable plugin");
    await f.click("Generate image");
    expect(p.onEnable).not.toHaveBeenCalled();
    expect(p.onGenerate).not.toHaveBeenCalled();
  });
});

describe("extension link and URL presentation", () => {
  it("accepts the configured HTTPS service root and rejects embedded credentials or a route", () => {
    expect(extensionBaseUrlValid("https://comfyui.example.com:8443/")).toBe(
      true,
    );
    for (const value of [
      "",
      "http://comfyui.example.com/",
      "https://secret@comfyui.example.com/",
      "https://comfyui.example.com/path",
      "https://comfyui.example.com/?token=secret",
      " https://comfyui.example.com/",
      "https://comfyui.example.com/#fragment",
    ])
      expect(extensionBaseUrlValid(value)).toBe(false);
  });
  it("rejects non-HTTPS, secret-bearing, malformed, and oversized result URLs", () => {
    expect(
      extensionResultUrl("https://comfyui.example.com/view?filename=image.png"),
    ).toBe("https://comfyui.example.com/view?filename=image.png");
    for (const value of [
      "http://example.com",
      "//example.com/view",
      "https://user:secret@example.com/view",
      "javascript:alert(1)",
      "\nhttps://example.com",
      `https://example.com/${"a".repeat(2_048)}`,
    ])
      expect(extensionResultUrl(value)).toBeNull();
  });
});
