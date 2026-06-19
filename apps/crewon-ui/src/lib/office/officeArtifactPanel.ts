import type {
  CapabilityPanel,
  CapabilityPanelItem,
} from "../capability/capabilityPanelTypes";
import { filePanelSearchControls } from "../capability/capabilityPanelText";
import type {
  ArtifactItem,
  LibraryPanel,
  OfficeMessage,
  OfficeWorkspace,
} from "../domain/crewonDomain";
import type { Locale } from "../i18n";

export function officeArtifactDisconnectedPanel(
  artifact: ArtifactItem,
  locale: Locale,
): CapabilityPanel {
  return {
    title: artifact.title,
    subtitle: locale === "zh" ? "办公室产物" : "Office artifact",
    body:
      locale === "zh"
        ? "连接 app-server 后会从当前工作区搜索并读取这个产物。"
        : "Connect app-server to search and read this artifact from the current workspace.",
  };
}

export function officeArtifactLocatingPanel(
  artifact: ArtifactItem,
  locale: Locale,
): CapabilityPanel {
  return {
    title: artifact.title,
    subtitle: locale === "zh" ? "正在定位产物" : "Locating artifact",
    body:
      locale === "zh"
        ? `正在工作区中搜索：${artifact.title}`
        : `Searching workspace for: ${artifact.title}`,
  };
}

export function officeArtifactErrorPanel(params: {
  artifact: ArtifactItem;
  error: unknown;
  locale: Locale;
}): CapabilityPanel {
  const { artifact, error, locale } = params;
  return {
    title: artifact.title,
    subtitle: locale === "zh" ? "办公室产物" : "Office artifact",
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "定位产物失败"
          : "Unable to locate artifact",
  };
}

export function officeArtifactDraftBody(params: {
  artifact: ArtifactItem;
  createdAtIso: string;
  locale: Locale;
  officeGoal?: string | null;
}): string {
  const { artifact, createdAtIso, locale, officeGoal } = params;
  return [
    `# ${artifact.title}`,
    "",
    `- ${locale === "zh" ? "类型" : "Kind"}: ${artifact.kind}`,
    `- ${locale === "zh" ? "来源" : "Source"}: Crewon office`,
    `- ${locale === "zh" ? "创建时间" : "Created"}: ${createdAtIso}`,
    officeGoal
      ? `- ${locale === "zh" ? "办公室目标" : "Office goal"}: ${officeGoal}`
      : null,
    "",
    artifact.meta,
    "",
    locale === "zh"
      ? "这里沉淀办公室协作产生的交付物。后续可由智能体、自动化或知识库复用。"
      : "This captures an office collaboration deliverable for reuse by agents, automations, or the knowledge library.",
    "",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function officeSavedArtifact(
  artifact: ArtifactItem,
  artifactPath: string,
  locale: Locale,
): ArtifactItem {
  return {
    ...artifact,
    meta:
      locale === "zh"
        ? `${artifact.meta} · 已保存 ${artifactPath}`
        : `${artifact.meta} · saved ${artifactPath}`,
  };
}

export function officeArtifactSystemMessage(params: {
  artifact: ArtifactItem;
  artifactPath: string;
  locale: Locale;
}): OfficeMessage {
  const { artifact, artifactPath, locale } = params;
  return {
    author: locale === "zh" ? "系统" : "System",
    glyph: "⌗",
    accent: artifact.accent,
    time: locale === "zh" ? "现在" : "now",
    kind: "system",
    text:
      locale === "zh"
        ? `已创建办公室产物：${artifact.title}，保存到 ${artifactPath}`
        : `Created office artifact: ${artifact.title}, saved to ${artifactPath}`,
  };
}

export function officeWorkspaceWithArtifactMessage(
  workspace: OfficeWorkspace,
  message: OfficeMessage,
): OfficeWorkspace {
  return {
    ...workspace,
    messages: [...workspace.messages, message],
  };
}

export function officeArtifactSavedPanel(
  panel: LibraryPanel | null,
  params: {
    threadId: string;
    workspace: OfficeWorkspace;
  },
): LibraryPanel | null {
  return panel?.workspace
    ? {
        ...panel,
        workspace: {
          ...params.workspace,
          threadId: params.threadId,
          backendStatus: "connected",
        },
      }
    : panel;
}

export function officeArtifactTurnPrompt(params: {
  artifact: ArtifactItem;
  body: string;
  locale: Locale;
  officeTitle: string;
}): string {
  const { artifact, body, locale, officeTitle } = params;
  return [
    locale === "zh"
      ? `办公室「${officeTitle}」创建产物：${artifact.title}`
      : `Office "${officeTitle}" created artifact: ${artifact.title}`,
    locale === "zh"
      ? "后端记录：已提交到 office/artifact/upsert"
      : "Backend record: submitted to office/artifact/upsert",
    "",
    body,
  ].join("\n");
}

export function officeArtifactDraftPanelBody(params: {
  artifactBody: string;
  locale: Locale;
  metadataText: string;
}): string {
  const { artifactBody, locale, metadataText } = params;
  return [
    locale === "zh"
      ? "未找到现有产物，已在工作区创建办公室产物草稿。"
      : "No existing artifact was found, so a workspace artifact draft was created.",
    metadataText,
    artifactBody,
  ].join("\n\n");
}

export function officeArtifactLoadedPanelBody(params: {
  fileText: string;
  locale: Locale;
  metadataText: string;
}): string {
  const { fileText, locale, metadataText } = params;
  const bodyText =
    fileText.length > 12000
      ? `${fileText.slice(0, 12000)}\n...`
      : fileText || (locale === "zh" ? "文件为空" : "Empty file");
  return [
    locale === "zh"
      ? "办公室产物已从后端工作区读取。"
      : "Office artifact loaded from the backend workspace.",
    metadataText,
    bodyText,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function officeArtifactDraftPanel(params: {
  artifact: ArtifactItem;
  artifactBody: string;
  artifactDir: string;
  artifactPath: string;
  locale: Locale;
  metadataText: string;
}): CapabilityPanel {
  const { artifact, artifactBody, artifactDir, artifactPath, locale, metadataText } =
    params;
  const controls = filePanelSearchControls(locale, artifactDir, artifact.title);
  return {
    title: artifact.title,
    subtitle: artifactPath,
    body: officeArtifactDraftPanelBody({
      artifactBody,
      locale,
      metadataText,
    }),
    actions: [copyCurrentPathAction(locale), ...(controls.actions ?? [])],
    fields: controls.fields,
  };
}

export function officeArtifactDirectoryPanel(params: {
  artifact: ArtifactItem;
  artifactPath: string;
  items: CapabilityPanelItem[];
  locale: Locale;
}): CapabilityPanel {
  const { artifact, artifactPath, items, locale } = params;
  return {
    title: artifact.title,
    subtitle: artifactPath,
    body:
      locale === "zh"
        ? "已定位到目录产物，正在读取目录内容..."
        : "Directory artifact located. Reading entries...",
    items,
    ...filePanelSearchControls(locale, artifactPath, artifact.title),
  };
}

export function officeArtifactLoadedPanel(params: {
  artifact: ArtifactItem;
  artifactPath: string;
  fileText: string;
  items: CapabilityPanelItem[];
  locale: Locale;
  metadataText: string;
  searchRoot: string;
}): CapabilityPanel {
  const { artifact, artifactPath, fileText, items, locale, metadataText, searchRoot } =
    params;
  const controls = filePanelSearchControls(locale, searchRoot, artifact.title);
  return {
    title: artifact.title,
    subtitle: artifactPath,
    body: officeArtifactLoadedPanelBody({
      fileText,
      locale,
      metadataText,
    }),
    actions: [copyCurrentPathAction(locale), ...(controls.actions ?? [])],
    fields: controls.fields,
    items,
  };
}

function copyCurrentPathAction(locale: Locale) {
  return {
    id: "copy-current-path",
    label: locale === "zh" ? "复制到 .copy" : "Copy to .copy",
  };
}
