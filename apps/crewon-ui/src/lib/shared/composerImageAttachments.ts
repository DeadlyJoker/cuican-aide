import type { ComposerImageInput } from "./composerImages";

export const maxComposerImages = 4;
export const maxComposerImageBytes = 10 * 1024 * 1024;

export type PendingComposerImage = ComposerImageInput & {
  id: string;
  name: string;
};

type ClipboardItem = Pick<DataTransferItem, "getAsFile" | "kind" | "type">;

export function pastedImageFiles(items: ArrayLike<ClipboardItem>): File[] {
  return Array.from(items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("无法读取图片"));
      }
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("无法读取图片"));
    });
    reader.readAsDataURL(file);
  });
}

export async function pendingComposerImagesFromFiles(
  files: File[],
  existingCount: number,
): Promise<PendingComposerImage[]> {
  const availableSlots = Math.max(0, maxComposerImages - existingCount);
  const acceptedFiles = files
    .filter(
      (file) =>
        file.type.startsWith("image/") && file.size <= maxComposerImageBytes,
    )
    .slice(0, availableSlots);

  return Promise.all(
    acceptedFiles.map(async (file, index) => ({
      detail: "auto" as const,
      id: `${file.name}-${file.size}-${file.lastModified}-${index}`,
      name: file.name,
      url: await readFileAsDataUrl(file),
    })),
  );
}
