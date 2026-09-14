import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import type { RunEventView, RunView } from "@crewon/contracts";
import { parseModelImageGeneratedData } from "@crewon/contracts";

const MAX_IMAGES_PER_RUN = 16;

export type ControlImageArtifact = Readonly<{
  artifactRef: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  byteLength: number;
}>;
export type ControlImageGenerationItem = Extract<
  ThreadItem,
  { type: "imageGeneration" }
> & {
  controlImage?: ControlImageArtifact;
};
type ImageEntry = {
  firstSequence: number;
  lastSequence: number;
  item: ControlImageGenerationItem;
};
// Image metadata shares the bounded Run projection's lifetime. No image bytes
// are retained in the transcript or its history cache.
const imagesByProjection = new WeakMap<object, Map<string, ImageEntry>>();
const overflowed = new WeakSet<object>();

export function controlImageArtifact(
  item: ControlImageGenerationItem,
): ControlImageArtifact | null {
  const value = item.controlImage;
  if (!value) return null;
  try {
    const parsed = parseModelImageGeneratedData({
      itemId: item.id,
      artifactRef: value.artifactRef,
      mimeType: value.mimeType,
      byteLength: value.byteLength,
    });
    return {
      artifactRef: parsed.artifactRef,
      mimeType: parsed.mimeType,
      byteLength: parsed.byteLength,
    };
  } catch {
    return null;
  }
}

export function applyControlImageEvent(
  projection: object,
  event: RunEventView,
): ControlImageGenerationItem | null {
  if (
    event.type !== "model.image.progress" &&
    event.type !== "model.image.generated"
  )
    return null;
  let images = imagesByProjection.get(projection);
  if (!images) {
    images = new Map();
    imagesByProjection.set(projection, images);
  }
  const existing = images.get(event.data.itemId);
  if (existing && event.sequence <= existing.lastSequence) return null;
  if (!existing && images.size >= MAX_IMAGES_PER_RUN) {
    overflowed.add(projection);
    return null;
  }
  // A delayed progress callback cannot downgrade a stored, usable image.
  if (existing?.item.controlImage && event.type === "model.image.progress")
    return null;
  const item: ControlImageGenerationItem = {
    type: "imageGeneration",
    id: event.data.itemId,
    status: "inProgress",
    revisedPrompt: null,
    result: "",
  };
  if (event.type === "model.image.generated") {
    item.controlImage = {
      artifactRef: event.data.artifactRef,
      mimeType: event.data.mimeType,
      byteLength: event.data.byteLength,
    };
    item.status = controlImageArtifact(item) ? "completed" : "failed";
    if (item.status === "failed") delete item.controlImage;
  }
  images.set(item.id, {
    firstSequence: existing?.firstSequence ?? event.sequence,
    lastSequence: event.sequence,
    item,
  });
  return item;
}

export function controlImageEntries(
  projection: object | undefined,
): readonly ImageEntry[] {
  return projection
    ? [...(imagesByProjection.get(projection)?.values() ?? [])]
    : [];
}

export function controlImageProjectionComplete(projection: object): boolean {
  return !overflowed.has(projection);
}

export function settleControlImageProjection(
  projection: object,
  terminal: Pick<RunView, "lastSequence" | "status" | "terminalAt">,
): ControlImageGenerationItem[] {
  if (
    terminal.terminalAt === null ||
    !["completed", "failed", "canceled"].includes(terminal.status)
  )
    return [];
  const settled: ControlImageGenerationItem[] = [];
  for (const entry of imagesByProjection.get(projection)?.values() ?? []) {
    if (entry.item.status !== "inProgress") continue;
    entry.item = { ...entry.item, status: "failed" };
    entry.lastSequence = Math.max(entry.lastSequence, terminal.lastSequence);
    settled.push(entry.item);
  }
  return settled;
}
