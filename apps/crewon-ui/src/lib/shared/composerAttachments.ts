import * as mammoth from "mammoth";
import * as XLSX from "xlsx";

const maxAttachmentBytes = 5 * 1024 * 1024;
const maxAttachmentCount = 20;
const maxAttachmentTextChars = 36_000;
const maxSingleAttachmentChars = 12_000;

export type ComposerAttachment = {
  content: string;
  id: string;
  name: string;
  relativePath: string;
};

function extension(name: string): string {
  const lastDot = name.lastIndexOf(".");
  return lastDot === -1 ? "" : name.slice(lastDot + 1).toLowerCase();
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n[内容已截断]` : value;
}

async function extractText(file: File): Promise<string> {
  const fileExtension = extension(file.name);
  if (["txt", "md", "csv", "json", "yaml", "yml", "xml", "html", "ts", "tsx", "js", "jsx", "py", "rs", "java", "sql"].includes(fileExtension)) {
    return file.text();
  }
  if (["xlsx", "xls"].includes(fileExtension)) {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const sheets = workbook.SheetNames.slice(0, 3).map((sheetName) => {
      const worksheet = workbook.Sheets[sheetName];
      return `工作表：${sheetName}\n${XLSX.utils.sheet_to_csv(worksheet)}`;
    });
    return sheets.join("\n\n");
  }
  if (fileExtension === "docx") {
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value;
  }
  throw new Error(`${file.name} 不是当前支持的文本、Excel 或 DOCX 文件。`);
}

export async function prepareComposerAttachments(
  files: File[],
): Promise<ComposerAttachment[]> {
  if (files.length === 0) {
    return [];
  }
  if (files.length > maxAttachmentCount) {
    throw new Error(`一次最多添加 ${maxAttachmentCount} 个文件。`);
  }
  const oversized = files.find((file) => file.size > maxAttachmentBytes);
  if (oversized) {
    throw new Error(`${oversized.name} 超过 5MB，无法加入会话。`);
  }

  let totalChars = 0;
  const attachments: ComposerAttachment[] = [];
  for (const file of files) {
    const content = truncate((await extractText(file)).trim(), maxSingleAttachmentChars);
    if (!content) {
      throw new Error(`${file.name} 没有可读取的文本内容。`);
    }
    if (totalChars + content.length > maxAttachmentTextChars) {
      throw new Error("附件文本超过本轮 36,000 字符上限，请减少文件或内容。");
    }
    totalChars += content.length;
    attachments.push({
      content,
      id: `${file.name}-${file.lastModified}-${file.size}`,
      name: file.name,
      relativePath: file.webkitRelativePath || file.name,
    });
  }
  return attachments;
}

export function attachmentContext(attachments: ComposerAttachment[]): string {
  if (attachments.length === 0) {
    return "";
  }
  return attachments
    .map((attachment) => `\n\n[附件：${attachment.relativePath}]\n${attachment.content}\n[附件结束]`)
    .join("");
}
