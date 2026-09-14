import { useContext, useEffect, useState } from "react";
import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import { Download, LoaderCircle, RefreshCw } from "lucide-react";
import type { Locale } from "../lib/i18n";
import {
  controlImageArtifact,
  type ControlImageArtifact,
} from "../lib/control-runtime/controlImageGeneration";
import { ArtifactClientContext } from "./ArtifactClientContext";
import "./TranscriptImageGenerationCard.css";

function isImageBytes(
  bytes: Uint8Array,
  mimeType: ControlImageArtifact["mimeType"],
): boolean {
  if (mimeType === "image/png")
    return [137, 80, 78, 71, 13, 10, 26, 10].every(
      (byte, index) => bytes[index] === byte,
    );
  if (mimeType === "image/jpeg")
    return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return (
    bytes.length >= 12 &&
    [82, 73, 70, 70].every((byte, index) => bytes[index] === byte) &&
    [87, 69, 66, 80].every((byte, index) => bytes[index + 8] === byte)
  );
}

function ArtifactImage({
  artifact,
  locale,
}: {
  artifact: ControlImageArtifact;
  locale: Locale;
}) {
  const client = useContext(ArtifactClientContext);
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<{
    client: typeof client;
    artifactRef: string;
    attempt: number;
    status: "ready" | "failed";
    url: string | null;
  } | null>(null);
  const [decodeFailedUrl, setDecodeFailedUrl] = useState<string | null>(null);
  const { artifactRef, mimeType, byteLength } = artifact;
  useEffect(() => {
    if (!client) return;
    const controller = new AbortController();
    let url: string | null = null;
    const timeout = setTimeout(() => {
      setLoad({ client, artifactRef, attempt, status: "failed", url: null });
      controller.abort();
    }, 30_000);
    void client
      .downloadArtifact(artifactRef, { signal: controller.signal })
      .then((download) => {
        if (controller.signal.aborted) return;
        if (
          download.mediaType.split(";", 1)[0]?.trim().toLowerCase() !==
            mimeType ||
          download.content.byteLength !== byteLength ||
          !isImageBytes(download.content, mimeType)
        ) {
          throw new Error("image_artifact_content_invalid");
        }
        // The authenticated client already bounds and verifies the digest. Only
        // validated raster bytes reach a browser-owned URL, never an event URL.
        url = URL.createObjectURL(
          new Blob([new Uint8Array(download.content)], { type: mimeType }),
        );
        clearTimeout(timeout);
        setLoad({ client, artifactRef, attempt, status: "ready", url });
      })
      .catch(() => {
        clearTimeout(timeout);
        if (!controller.signal.aborted)
          setLoad({
            client,
            artifactRef,
            attempt,
            status: "failed",
            url: null,
          });
      });
    return () => {
      clearTimeout(timeout);
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, artifactRef, mimeType, byteLength, attempt]);
  const current =
    load?.client === client &&
    load.artifactRef === artifactRef &&
    load.attempt === attempt
      ? load
      : null;
  const failed =
    !client ||
    current?.status === "failed" ||
    (current?.url != null && current.url === decodeFailedUrl);
  if (failed)
    return (
      <div className="transcript-image-notice">
        <p role="alert">
          {locale === "zh"
            ? "图片加载失败，可能已过期或暂时无法访问。"
            : "The image could not be loaded. It may have expired or be temporarily unavailable."}
        </p>
        {client ? (
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {locale === "zh" ? "重新加载图片" : "Reload image"}
          </button>
        ) : null}
      </div>
    );
  if (current?.status !== "ready" || !current.url)
    return (
      <p className="transcript-image-notice" role="status">
        {locale === "zh" ? "正在加载图片…" : "Loading image…"}
      </p>
    );
  const extension =
    mimeType === "image/jpeg"
      ? "jpg"
      : mimeType === "image/webp"
        ? "webp"
        : "png";
  return (
    <figure className="transcript-generated-image">
      <img
        src={current.url}
        alt={locale === "zh" ? "生成的图片" : "Generated image"}
        onError={() => {
          if (current.url) URL.revokeObjectURL(current.url);
          setDecodeFailedUrl(current.url);
        }}
      />
      <figcaption>
        <a href={current.url} download={`crewon-image.${extension}`}>
          <Download size={14} aria-hidden="true" />
          {locale === "zh" ? "保存图片" : "Save image"}
        </a>
      </figcaption>
    </figure>
  );
}

export function TranscriptImageGenerationCard({
  item,
  locale,
}: {
  item: Extract<ThreadItem, { type: "imageGeneration" }>;
  locale: Locale;
}) {
  const artifact = controlImageArtifact(item);
  const completed = item.status === "completed" || item.status === "succeeded";
  const failed =
    item.status === "failed" ||
    item.status === "canceled" ||
    item.status === "cancelled" ||
    item.status === "error";
  const label = failed
    ? locale === "zh"
      ? "图片生成失败，请重试。"
      : "Image generation failed. Please try again."
    : completed
      ? locale === "zh"
        ? "图片已生成"
        : "Image generated"
      : locale === "zh"
        ? "正在生成图片…"
        : "Generating image…";
  return (
    <div
      className="tool-card action-card transcript-image-generation"
      data-status={failed ? "failed" : completed ? "completed" : "inProgress"}
    >
      <div
        className="tool-card-header action-card-header"
        role={failed ? "alert" : "status"}
      >
        {!completed && !failed ? (
          <LoaderCircle size={16} aria-hidden="true" />
        ) : null}
        <span className="tool-action-verb">{label}</span>
      </div>
      {artifact && completed ? (
        <ArtifactImage
          key={`${artifact.artifactRef}:${artifact.mimeType}:${artifact.byteLength}`}
          artifact={artifact}
          locale={locale}
        />
      ) : null}
      {completed && !artifact ? (
        <p className="transcript-image-notice">
          {item.savedPath
            ? `${locale === "zh" ? "图片已保存至" : "Image saved to"} ${item.savedPath}`
            : locale === "zh"
              ? "此图片没有可用的预览文件，请重新生成。"
              : "No preview file is available for this image. Please generate it again."}
        </p>
      ) : null}
    </div>
  );
}
