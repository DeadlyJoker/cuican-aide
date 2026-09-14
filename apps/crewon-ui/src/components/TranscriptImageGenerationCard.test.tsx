// @vitest-environment happy-dom
import { act, type ContextType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactClientContext } from "./ArtifactClientContext";
import { TranscriptImageGenerationCard } from "./TranscriptImageGenerationCard";
import { TranscriptTurn } from "./TranscriptTurn";
import type { ControlImageGenerationItem } from "../lib/control-runtime/controlImageGeneration";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const download = {
  content: bytes,
  mediaType: "image/png",
  contentDigest: `sha256:${"a".repeat(64)}`,
};
const item: ControlImageGenerationItem = {
  type: "imageGeneration",
  id: "image-1",
  status: "completed",
  revisedPrompt: null,
  result: "",
  controlImage: {
    artifactRef: "artifact:image-1",
    mimeType: "image/png",
    byteLength: bytes.length,
  },
};
describe("generated image delivery", () => {
  let host: HTMLDivElement;
  let root: Root;
  const createObjectURL = vi.fn(() => "blob:crewon-image");
  const revokeObjectURL = vi.fn();
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = revokeObjectURL;
      },
    );
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });
  async function show(
    client: ContextType<typeof ArtifactClientContext>,
    image = item,
  ) {
    await act(async () =>
      root.render(
        <ArtifactClientContext.Provider value={client}>
          <TranscriptImageGenerationCard item={image} locale="zh" />
        </ArtifactClientContext.Provider>,
      ),
    );
  }
  it("announces image generation immediately without downloading or retaining model base64", async () => {
    const client = { downloadArtifact: vi.fn() };
    await show(client, {
      ...item,
      controlImage: undefined,
      status: "inProgress",
      result: "data:image/png;base64,SHOULD_NOT_RENDER",
    });
    expect(host.textContent).toContain("正在生成图片");
    expect(host.innerHTML).not.toContain("SHOULD_NOT_RENDER");
    expect(client.downloadArtifact).not.toHaveBeenCalled();
    expect(host.innerHTML).toMatchSnapshot();
  });
  it("uses authenticated artifact bytes for preview and download, and revokes the URL on unmount", async () => {
    const client = { downloadArtifact: vi.fn().mockResolvedValue(download) };
    await show(client);
    expect(client.downloadArtifact).toHaveBeenCalledWith("artifact:image-1", {
      signal: expect.any(AbortSignal),
    });
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(host.querySelector("img")?.getAttribute("src")).toBe(
      "blob:crewon-image",
    );
    expect(host.querySelector("a")?.getAttribute("download")).toBe(
      "crewon-image.png",
    );
    expect(host.querySelector("a")?.textContent).toContain("保存图片");
    expect(host.innerHTML).toMatchSnapshot();
    await act(async () => root.unmount());
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:crewon-image");
  });
  it("drops a late download when account changes and never previews unverified bytes", async () => {
    let finish!: (value: typeof download) => void;
    const oldClient = {
      downloadArtifact: vi.fn<
        NonNullable<
          ContextType<typeof ArtifactClientContext>
        >["downloadArtifact"]
      >(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    };
    await show(oldClient);
    const oldSignal = oldClient.downloadArtifact.mock.calls[0]?.[1]?.signal;
    await show({
      downloadArtifact: vi
        .fn()
        .mockResolvedValue({ ...download, mediaType: "image/svg+xml" }),
    });
    await act(async () => finish(download));
    expect(oldSignal?.aborted).toBe(true);
    expect(host.textContent).toContain("图片加载失败");
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(host.querySelector("img")).toBeNull();
  });
  it("revokes a loaded preview when signing out and re-reads the artifact on return", async () => {
    const client = { downloadArtifact: vi.fn().mockResolvedValue(download) };
    await show(client);
    await show(null);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:crewon-image");
    expect(host.querySelector("img")).toBeNull();
    await show(client);
    expect(client.downloadArtifact).toHaveBeenCalledTimes(2);
    expect(host.querySelector("img")).not.toBeNull();
  });
  it("makes a stalled artifact request retryable after the bounded wait", async () => {
    vi.useFakeTimers();
    try {
      const client = {
        downloadArtifact: vi.fn<
          NonNullable<
            ContextType<typeof ArtifactClientContext>
          >["downloadArtifact"]
        >(() => new Promise(() => {})),
      };
      await show(client);
      expect(host.textContent).toContain("正在加载图片");
      await act(async () => vi.advanceTimersByTime(30_000));
      expect(client.downloadArtifact.mock.calls[0]?.[1]?.signal?.aborted).toBe(
        true,
      );
      expect(host.textContent).toContain("重新加载图片");
    } finally {
      vi.useRealTimers();
    }
  });
  it("offers a retry after an expired or unavailable artifact and hides technical error details", async () => {
    const client = {
      downloadArtifact: vi
        .fn()
        .mockRejectedValueOnce(new Error("artifact_internal_path_denied"))
        .mockResolvedValue(download),
    };
    await show(client);
    expect(host.textContent).toContain("图片加载失败");
    expect(host.textContent).not.toContain("artifact_internal");
    await act(async () => host.querySelector("button")!.click());
    expect(client.downloadArtifact).toHaveBeenCalledTimes(2);
    expect(host.querySelector("img")).not.toBeNull();
  });
  it.each([
    { ...download, content: new Uint8Array(bytes.length) },
    { ...download, content: bytes.slice(0, 8) },
  ])("rejects MIME spoofing or length mismatch", async (response) => {
    await show({ downloadArtifact: vi.fn().mockResolvedValue(response) });
    expect(host.textContent).toContain("图片加载失败");
    expect(createObjectURL).not.toHaveBeenCalled();
  });
  it("shows image decode failure and a failed generation clearly", async () => {
    await show({ downloadArtifact: vi.fn().mockResolvedValue(download) });
    await act(async () =>
      host.querySelector("img")!.dispatchEvent(new Event("error")),
    );
    expect(host.textContent).toContain("图片加载失败");
    expect(host.querySelector("a")).toBeNull();
    await show(null, { ...item, controlImage: undefined, status: "failed" });
    expect(host.textContent).toContain("图片生成失败，请重试");
    expect(host.textContent).not.toContain("正在生成");
  });
  it("keeps a completed image visible outside the collapsed process group", () => {
    const markup = renderToStaticMarkup(
      <TranscriptTurn
        turn={{
          id: "run-1",
          items: [item],
          itemsView: "full",
          status: "completed",
          error: null,
          durationMs: 1200,
          startedAt: null,
          completedAt: null,
        }}
        turnIndex={0}
        locale="zh"
        itemLabels={{
          commandLabel: "命令",
          crewonLabel: "CrewON",
          filesLabel: "文件",
          planLabel: "计划",
          reasoningLabel: "推理",
          youLabel: "你",
        }}
        crewonLabel="CrewON"
        hasWorkbench={false}
        shouldShowThinking={false}
        hidesDurableFinalWhileStreaming={false}
        isLatestResponse
      />,
    );
    expect(markup).toContain("图片已生成");
    expect(markup).not.toContain("turn-process-group");
  });
});
