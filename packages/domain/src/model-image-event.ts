export type ModelImageProgressEventData = Readonly<{
  segmentId: string;
  segmentSequence: number;
  itemId: string;
  stage: "in_progress" | "generating" | "completed";
}>;

export type ModelImageGeneratedEventData = Readonly<{
  segmentId: string;
  segmentSequence: number;
  itemId: string;
  artifactRef: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  byteLength: number;
}>;

/** Stored image events carry bounded references only, including on direct store writes. */
export function validModelImageEventData(
  type: "model.image.progress" | "model.image.generated",
  data: ModelImageProgressEventData | ModelImageGeneratedEventData,
): boolean {
  const generated = type === "model.image.generated";
  const keys = generated
    ? [
        "segmentId",
        "segmentSequence",
        "itemId",
        "artifactRef",
        "mimeType",
        "byteLength",
      ]
    : ["segmentId", "segmentSequence", "itemId", "stage"];
  if (
    Object.keys(data).sort().join("\0") !== keys.sort().join("\0") ||
    !opaqueId(data.itemId)
  )
    return false;
  if (!generated)
    return (
      "stage" in data &&
      ["in_progress", "generating", "completed"].includes(data.stage)
    );
  return (
    "artifactRef" in data &&
    opaqueId(data.artifactRef) &&
    ["image/png", "image/jpeg", "image/webp"].includes(data.mimeType) &&
    Number.isSafeInteger(data.byteLength) &&
    data.byteLength > 0 &&
    data.byteLength <= 8 * 1024 * 1024
  );
}

function opaqueId(value: string): boolean {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value) &&
    !/^(?:data|https?|file):/iu.test(value)
  );
}
