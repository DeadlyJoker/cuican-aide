import type { PendingComposerMention } from "./composerMentions";
import {
  attachmentContext,
  prepareComposerAttachments,
} from "./composerAttachments";

export type LocalResourceSelectionKind = "files" | "folder";

export type LocalResourceAttachmentClient = {
  createDirectory(path: string, recursive?: boolean): Promise<unknown>;
  writeFile(path: string, dataBase64: string): Promise<unknown>;
};

const maxAttachmentFiles = 200;
const maxAttachmentFileBytes = 25 * 1024 * 1024;
const maxAttachmentTotalBytes = 100 * 1024 * 1024;

function pathSeparator(path: string): "/" | "\\" {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

function joinPath(root: string, ...segments: string[]): string {
  const separator = pathSeparator(root);
  const trimmedRoot = root.replace(/[\\/]+$/, "");
  return [trimmedRoot, ...segments].join(separator);
}

function safePathSegments(file: File, kind: LocalResourceSelectionKind) {
  const relativePath =
    kind === "folder" && file.webkitRelativePath
      ? file.webkitRelativePath
      : file.name;
  return relativePath
    .split(/[\\/]+/)
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .map((segment) => segment.replace(/[\0<>:"|?*]/g, "_").trim())
    .filter(Boolean);
}

function parentPath(path: string): string {
  const separator = pathSeparator(path);
  const index = path.lastIndexOf(separator);
  return index > 0 ? path.slice(0, index) : path;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return globalThis.btoa(binary);
}

async function fileDataBase64(file: File): Promise<string> {
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}

function defaultBatchId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Reads browser-selected files into bounded conversation context. This is the
 * primary path for the TypeScript Control runtime and works in both Electron
 * and the deployed web client without a native filesystem bridge.
 */
export async function inlineLocalResourceAttachments({
  batchId = defaultBatchId(),
  files,
  kind,
}: {
  batchId?: string;
  files: File[];
  kind: LocalResourceSelectionKind;
}): Promise<PendingComposerMention[]> {
  const selectedFiles = files.filter((file) => file.name !== ".DS_Store");
  const attachments = await prepareComposerAttachments(selectedFiles);
  if (attachments.length === 0) {
    throw new Error("没有可添加的文件");
  }

  if (kind === "folder") {
    const firstSegments = safePathSegments(selectedFiles[0], kind);
    const folderName = firstSegments[0] || "所选文件夹";
    return [
      {
        content: attachmentContext(attachments).trim(),
        name: folderName,
        path: `local-attachment://${batchId}/${encodeURIComponent(folderName)}`,
        resourceKind: "folder",
      },
    ];
  }

  return attachments.map((attachment) => ({
    content: attachment.content,
    name: attachment.name,
    path: `local-attachment://${batchId}/${attachment.relativePath
      .split(/[\\/]+/)
      .map(encodeURIComponent)
      .join("/")}`,
    resourceKind: "file",
  }));
}

export async function stageLocalResourceAttachments({
  batchId = defaultBatchId(),
  client,
  cwd,
  files,
  kind,
}: {
  batchId?: string;
  client: LocalResourceAttachmentClient;
  cwd: string;
  files: File[];
  kind: LocalResourceSelectionKind;
}): Promise<PendingComposerMention[]> {
  const selectedFiles = files.filter((file) => file.name !== ".DS_Store");
  if (!cwd.trim()) {
    throw new Error("请先选择工作空间");
  }
  if (selectedFiles.length === 0) {
    throw new Error("没有可添加的文件");
  }
  if (selectedFiles.length > maxAttachmentFiles) {
    throw new Error(`一次最多添加 ${maxAttachmentFiles} 个文件`);
  }
  if (selectedFiles.some((file) => file.size > maxAttachmentFileBytes)) {
    throw new Error("单个文件不能超过 25 MB");
  }
  const totalBytes = selectedFiles.reduce(
    (total, file) => total + file.size,
    0,
  );
  if (totalBytes > maxAttachmentTotalBytes) {
    throw new Error("一次添加的文件总大小不能超过 100 MB");
  }

  const attachmentRoot = joinPath(cwd, ".crewon", "attachments", batchId);
  await client.createDirectory(attachmentRoot, true);
  const stagedFiles: Array<{ file: File; path: string; segments: string[] }> =
    [];
  for (const file of selectedFiles) {
    const segments = safePathSegments(file, kind);
    if (segments.length === 0) {
      continue;
    }
    const stagedPath = joinPath(attachmentRoot, ...segments);
    await client.createDirectory(parentPath(stagedPath), true);
    await client.writeFile(stagedPath, await fileDataBase64(file));
    stagedFiles.push({ file, path: stagedPath, segments });
  }

  if (stagedFiles.length === 0) {
    throw new Error("没有可添加的文件");
  }
  if (kind === "folder") {
    const folderName = stagedFiles[0].segments[0];
    return [
      {
        name: folderName,
        path: joinPath(attachmentRoot, folderName),
        resourceKind: "folder",
      },
    ];
  }
  return stagedFiles.map(({ file, path }) => ({
    name: file.name,
    path,
    resourceKind: "file",
  }));
}
