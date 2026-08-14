import type { ControlApiClient } from "@crewon/control-client";

import type { ControlKnowledgeSelection } from "../control-runtime/controlComposerResourceDiscovery";
import type { Locale } from "../i18n";
import type { LocalResourceSelectionKind } from "../shared/localResourceAttachments";

const MAX_FILES = 4;
const MAX_FILE_BYTES = 8 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024;
const MAX_TITLE_BYTES = 256;

type PreparedFile = Readonly<{
  content: string;
  sourceId: string;
  title: string;
}>;

export async function importControlKnowledgeFiles(params: {
  client: Pick<ControlApiClient, "createKnowledge">;
  files: readonly File[];
  kind: LocalResourceSelectionKind;
  locale: Locale;
  maximumFiles?: number;
}): Promise<ControlKnowledgeSelection[]> {
  const maximumFiles = Math.min(params.maximumFiles ?? MAX_FILES, MAX_FILES);
  if (!Number.isInteger(maximumFiles) || maximumFiles < 1) {
    throw new Error(
      copy(
        params.locale,
        "当前任务最多引用 4 项知识",
        "This task can reference at most 4 Knowledge items",
      ),
    );
  }
  const selected = params.files.filter((file) => file.name !== ".DS_Store");
  if (selected.length === 0) {
    throw new Error(copy(params.locale, "没有可添加的文件", "No files to add"));
  }
  if (selected.length > maximumFiles) {
    throw new Error(
      copy(
        params.locale,
        `当前任务还可添加 ${maximumFiles} 个文件`,
        `This task can add ${maximumFiles} more file${maximumFiles === 1 ? "" : "s"}`,
      ),
    );
  }
  const prepared = await Promise.all(
    selected.map((file) => prepareFile(file, params.kind, params.locale)),
  );
  if (
    prepared.reduce(
      (total, file) =>
        total + new TextEncoder().encode(file.content).byteLength,
      0,
    ) > MAX_TOTAL_BYTES
  ) {
    throw new Error(
      copy(
        params.locale,
        "文件内容总量不能超过 24 KiB",
        "File content cannot exceed 24 KiB in total",
      ),
    );
  }

  const selections: ControlKnowledgeSelection[] = [];
  for (const file of prepared) {
    const response = await params.client.createKnowledge(
      {
        kind: "source",
        sourceId: file.sourceId,
        title: file.title,
        content: file.content,
      },
      `knowledge-file:${file.sourceId.slice("local-file:".length)}`,
    );
    selections.push({
      reference: {
        knowledgeId: response.knowledge.knowledgeId,
        contentDigest: response.knowledge.contentDigest,
      },
      sourceId: response.knowledge.sourceId,
      title: response.knowledge.title,
    });
  }
  return selections;
}

async function prepareFile(
  file: File,
  kind: LocalResourceSelectionKind,
  locale: Locale,
): Promise<PreparedFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error(
      copy(
        locale,
        "单个文件内容不能超过 8 KiB",
        "Each file must be 8 KiB or smaller",
      ),
    );
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .normalize("NFC");
  } catch {
    throw new Error(
      copy(
        locale,
        "只能添加 UTF-8 文本文件",
        "Only UTF-8 text files can be added",
      ),
    );
  }
  if (
    content.length === 0 ||
    new TextEncoder().encode(content).byteLength > MAX_FILE_BYTES
  ) {
    throw new Error(
      copy(locale, "文件内容为空或过大", "The file is empty or too large"),
    );
  }
  const title = (
    kind === "folder" && file.webkitRelativePath
      ? file.webkitRelativePath
      : file.name
  ).normalize("NFC");
  if (
    title.length === 0 ||
    new TextEncoder().encode(title).byteLength > MAX_TITLE_BYTES
  ) {
    throw new Error(copy(locale, "文件名过长", "The file name is too long"));
  }
  const identity = await sha256(
    JSON.stringify({
      schemaVersion: "crewon.local-knowledge-file.v0",
      title,
      content,
    }),
  );
  return {
    content,
    sourceId: `local-file:${identity}`,
    title,
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function copy(locale: Locale, zh: string, en: string): string {
  return locale === "zh" ? zh : en;
}
