import {
  DELIVERY_LIMITS,
  XLSX_MEDIA_TYPE,
  type SpreadsheetCellValue,
} from "@crewon/domain/delivery";

export function deliveryColumn(index: number): string {
  let result = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
  return result;
}
export function deliveryFailure(error: unknown, zh: boolean): string {
  const code = error instanceof Error ? error.message : "";
  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    error.status === 409
  )
    return zh
      ? "版本已变化。你的编辑已保留，请载入最新版本核对后重新保存。"
      : "The version changed. Your edit is preserved. Load the latest version and review before saving.";
  if (/unavailable|not_found|not_enabled|404|503/iu.test(code))
    return zh
      ? "文件交付服务暂不可用，请稍后重试。"
      : "File delivery is unavailable. Try again later.";
  if (/unsupported|formula|pivot|macro|external/iu.test(code))
    return zh
      ? `该文件包含首版不支持的表格结构或公式：${code}`
      : `Unsupported workbook structure or formula: ${code}`;
  return zh
    ? `操作未完成：${code || "请重试"}`
    : `Operation failed: ${code || "try again"}`;
}
export async function deliveryUploadBytes(
  file: File,
  role: "data" | "template",
) {
  const extension = file.name.toLowerCase().split(".").pop();
  if (file.size < 1 || file.size > DELIVERY_LIMITS.fileBytes)
    throw new Error("每份文件须为 1 字节至 10 MiB");
  if (extension !== "xlsx" && (extension !== "csv" || role !== "data"))
    throw new Error("数据支持 CSV/XLSX，模板仅支持 XLSX");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return {
    name: file.name,
    role,
    mediaType: extension === "xlsx" ? XLSX_MEDIA_TYPE : ("text/csv" as const),
    contentBase64: btoa(binary),
  };
}
export type DeliveryEditKind =
  | "text"
  | "number"
  | "boolean"
  | "empty"
  | "formula";
export function deliveryEditValue(
  kind: DeliveryEditKind,
  value: string,
): SpreadsheetCellValue | { formula: string } {
  if (kind === "empty") return null;
  if (kind === "text") return value;
  if (kind === "formula") {
    if (!value.trim()) throw new Error("公式不能为空");
    return { formula: value.replace(/^=/u, "") };
  }
  if (kind === "boolean") {
    if (value !== "true" && value !== "false")
      throw new Error("布尔值须为 true 或 false");
    return value === "true";
  }
  if (!value.trim() || !Number.isFinite(Number(value)))
    throw new Error("请输入有限数值");
  return Number(value);
}
