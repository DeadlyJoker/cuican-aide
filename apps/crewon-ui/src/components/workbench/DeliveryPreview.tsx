import { useEffect, useRef, useState } from "react";
import type {
  DeliveryControlClient,
  DeliveryFileRef,
} from "@crewon/control-client";
import type {
  DeliveryInputRecord,
  DeliveryPatchRequest,
  DeliveryVersionRecord,
  SpreadsheetPage,
  SpreadsheetCellValue,
} from "@crewon/domain/delivery";
import {
  deliveryColumn,
  deliveryEditValue,
  deliveryFailure,
  type DeliveryEditKind,
} from "./deliveryUi";

export type DeliverySelection = Readonly<{
  ref: DeliveryFileRef;
  record: DeliveryInputRecord | DeliveryVersionRecord;
}>;
type Edit = {
  deliveryId: string;
  versionId: string;
  digest: string;
  sheet: string;
  cell: string;
  value: string;
  kind: DeliveryEditKind;
  numberFormat: "" | "0" | "0.0" | "0.00";
};

export function DeliveryPreview({
  client,
  threadId,
  selection,
  busy,
  zh,
  signal,
  inputNames = {},
  operationError = "",
  onPatch,
  onReload,
  onSelect,
}: {
  client: DeliveryControlClient;
  threadId: string;
  selection: DeliverySelection;
  busy: boolean;
  zh: boolean;
  signal: AbortSignal;
  inputNames?: Readonly<Record<string, string>>;
  operationError?: string;
  onPatch: (request: DeliveryPatchRequest) => Promise<boolean>;
  onReload: (deliveryId: string) => Promise<DeliveryVersionRecord | null>;
  onSelect: (selection: DeliverySelection) => void;
}) {
  const { ref, record } = selection;
  const version = "versionId" in record ? record : null;
  const [sheet, setSheet] = useState(record.inspection.sheets[0]?.name ?? "");
  const [startRow, setStartRow] = useState(1);
  const [loadedPage, setLoadedPage] = useState<{
    fileId: string;
    page: SpreadsheetPage;
  } | null>(null);
  const previewElement = useRef<HTMLElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState<Edit | null>(null);
  const [history, setHistory] = useState<readonly DeliveryVersionRecord[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const selected = useRef(ref.id);
  selected.current = ref.id;
  const activeSheet = record.inspection.sheets.some((s) => s.name === sheet)
    ? sheet
    : (record.inspection.sheets[0]?.name ?? "");
  const editForSelection =
    edit && version && edit.deliveryId === version.deliveryId ? edit : null;
  const page =
    loadedPage?.fileId === ref.id &&
    loadedPage.page.sheet === activeSheet &&
    loadedPage.page.startRow === startRow
      ? loadedPage.page
      : null;
  useEffect(() => {
    const controller = new AbortController();
    setLoadedPage(null);
    setLoading(true);
    setError("");
    void client
      .page(
        threadId,
        ref,
        { sheet: activeSheet, startRow, limit: 50 },
        { signal: controller.signal },
      )
      .then(
        (result) => {
          if (!controller.signal.aborted)
            setLoadedPage({ fileId: ref.id, page: result });
        },
        (cause) => {
          if (!controller.signal.aborted) setError(deliveryFailure(cause, zh));
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, threadId, ref.kind, ref.id, activeSheet, startRow, zh]);
  useEffect(() => {
    setStartRow(1);
    setHistory([]);
    setDownloading(false);
    setLoadingHistory(false);
    previewElement.current?.scrollIntoView({
      block: "start",
      behavior: "instant",
    });
  }, [ref.id]);
  async function download() {
    const id = ref.id;
    setDownloading(true);
    setError("");
    try {
      const bytes = await client.download(threadId, ref, record, { signal });
      if (signal.aborted || selected.current !== id) return;
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      const url = URL.createObjectURL(
        new Blob([buffer], { type: record.mediaType }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = record.name;
      anchor.click();
      // Preserve the browser's download navigation long enough to consume the URL.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      if (!signal.aborted && selected.current === id)
        setError(deliveryFailure(cause, zh));
    } finally {
      if (!signal.aborted && selected.current === id) setDownloading(false);
    }
  }
  function selectCell(
    row: number,
    column: number,
    value: SpreadsheetCellValue,
  ) {
    if (!version) return;
    setEdit({
      deliveryId: version.deliveryId,
      versionId: version.versionId,
      digest: version.contentDigest,
      sheet: activeSheet,
      cell: `${deliveryColumn(column)}${row}`,
      value: value === null ? "" : String(value),
      kind:
        value === null
          ? "empty"
          : typeof value === "number"
            ? "number"
            : typeof value === "boolean"
              ? "boolean"
              : "text",
      numberFormat: "",
    });
  }
  return (
    <section
      ref={previewElement}
      className="delivery-preview"
      aria-label={zh ? "表格文件预览" : "Spreadsheet preview"}
    >
      <header>
        <strong>{record.name}</strong>
        <small>
          {record.byteLength.toLocaleString()} B · {zh ? "已保存" : "Saved"}
        </small>
        {version && (
          <>
            <small>
              {zh ? "版本" : "Version"} {version.versionId}
            </small>
            <small>
              {version.sourceRunId
                ? `${zh ? "运行" : "Run"}: ${version.sourceRunId}`
                : zh
                  ? "用户保存"
                  : "Saved by user"}
            </small>
          </>
        )}
        <div className="delivery-actions">
          <button
            disabled={downloading}
            type="button"
            onClick={() => void download()}
          >
            {downloading
              ? zh
                ? "正在核对文件…"
                : "Verifying file…"
              : zh
                ? "下载原文件"
                : "Download file"}
          </button>
          {version && (
            <button
              type="button"
              disabled={loadingHistory || busy}
              onClick={async () => {
                const id = ref.id;
                setLoadingHistory(true);
                try {
                  const result = await client.history(
                    threadId,
                    version.deliveryId,
                    { signal },
                  );
                  if (!signal.aborted && selected.current === id)
                    setHistory(result);
                } catch (cause) {
                  if (!signal.aborted && selected.current === id)
                    setError(deliveryFailure(cause, zh));
                } finally {
                  if (!signal.aborted && selected.current === id)
                    setLoadingHistory(false);
                }
              }}
            >
              {zh ? "历史版本" : "Version history"}
            </button>
          )}
        </div>
      </header>
      {history.length > 0 && (
        <label>
          {zh ? "查看已保存版本" : "Saved version"}
          <select
            disabled={busy}
            value={ref.id}
            onChange={(event) => {
              const record = history.find(
                (v) => v.versionId === event.target.value,
              );
              if (record)
                onSelect({
                  ref: { kind: "version", id: record.versionId },
                  record,
                });
            }}
          >
            {history.map((v) => (
              <option key={v.versionId} value={v.versionId}>
                {v.createdAt} · {v.versionId}
              </option>
            ))}
          </select>
        </label>
      )}
      {version && (
        <details className="delivery-checks">
          <summary>{zh ? "文件验证与来源" : "Validation and sources"}</summary>
          <p>
            {zh ? "已验证" : "Verified"} · {version.validation.writtenRows}{" "}
            {zh ? "行写入" : "rows written"} · {version.validation.formulaCount}{" "}
            {zh ? "个公式" : "formulas"}
          </p>
          {version.validation.sources.map((source, i) => (
            <p key={i}>
              {inputNames[source.inputId] ?? source.inputId} · {source.sheet} ·{" "}
              {zh
                ? "读取 / 写入 / 空行排除"
                : "Read / written / blank excluded"}
              : {source.readRows} / {source.writtenRows} /{" "}
              {source.excludedBlankRows}
            </p>
          ))}
          {version.validation.sources
            .filter(
              (source) =>
                source.excludedRuleRows !== undefined ||
                source.exceptionRows !== undefined,
            )
            .map((source, i) => (
              <p key={`rule-${i}`}>
                {inputNames[source.inputId] ?? source.inputId} · {source.sheet}{" "}
                · {zh ? "条件排除 / 异常" : "Rule excluded / exceptions"}:{" "}
                {source.excludedRuleRows ?? 0} / {source.exceptionRows ?? 0}
              </p>
            ))}
          {Object.entries(version.validation.numericTotals).map(
            ([column, sum]) => (
              <p key={column}>
                {column} {zh ? "合计" : "total"}: {sum}
              </p>
            ),
          )}
          {version.validation.warnings.map((warning, i) => (
            <p key={i}>{warning}</p>
          ))}
          <small className="delivery-digest">{version.contentDigest}</small>
        </details>
      )}
      <label>
        {zh ? "工作表" : "Sheet"}
        <select
          value={activeSheet}
          onChange={(event) => {
            setSheet(event.target.value);
            setStartRow(1);
          }}
        >
          {record.inspection.sheets.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name} · {s.rows} × {s.columns}
            </option>
          ))}
        </select>
      </label>
      {loading && (
        <p role="status">{zh ? "正在读取表格…" : "Loading table…"}</p>
      )}
      {page && (
        <>
          <div
            className="delivery-table-scroll"
            tabIndex={0}
            aria-label={
              zh ? "表格内容，可横向滚动" : "Table, scroll horizontally"
            }
          >
            <table>
              <caption>
                {activeSheet} · {zh ? "共" : "Total"} {page.totalRows} ×{" "}
                {page.totalColumns}
              </caption>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  {Array.from({ length: page.totalColumns }, (_, i) => (
                    <th scope="col" key={i}>
                      {deliveryColumn(i)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.rows.map((row, i) => (
                  <tr key={page.startRow + i}>
                    <th scope="row">{page.startRow + i}</th>
                    {Array.from({ length: page.totalColumns }, (_, j) => (
                      <td key={j}>
                        {version ? (
                          <button
                            type="button"
                            disabled={busy}
                            aria-label={`${activeSheet}!${deliveryColumn(j)}${page.startRow + i}: ${row[j] ?? ""}`}
                            onClick={() =>
                              selectCell(page.startRow + i, j, row[j] ?? null)
                            }
                          >
                            {String(row[j] ?? "") || " "}
                          </button>
                        ) : (
                          String(row[j] ?? "")
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav
            className="delivery-actions"
            aria-label={zh ? "表格分页" : "Table pages"}
          >
            <button
              type="button"
              disabled={page.startRow === 1}
              onClick={() => setStartRow(1)}
            >
              {zh ? "回到首行" : "First row"}
            </button>
            <span>
              {page.startRow}–
              {Math.max(page.startRow, page.startRow + page.rows.length - 1)} /{" "}
              {page.totalRows}
            </span>
            <button
              type="button"
              disabled={page.nextRow === null}
              onClick={() => {
                if (page.nextRow !== null) setStartRow(page.nextRow);
              }}
            >
              {zh ? "下一页" : "Next page"}
            </button>
          </nav>
        </>
      )}
      {version && !editForSelection && (
        <p>
          {zh
            ? "点击单元格定向修改；保存会创建新版本。"
            : "Select a cell to edit. Saving creates a new version."}
        </p>
      )}
      {editForSelection && (
        <form
          className="delivery-cell-edit"
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              const value = deliveryEditValue(
                editForSelection.kind,
                editForSelection.value,
              );
              const saved = await onPatch({
                deliveryId: editForSelection.deliveryId,
                expectedVersionId: editForSelection.versionId,
                expectedContentDigest: editForSelection.digest,
                patches: [
                  {
                    sheet: editForSelection.sheet,
                    cell: editForSelection.cell,
                    value,
                    ...(editForSelection.numberFormat
                      ? { numberFormat: editForSelection.numberFormat }
                      : {}),
                  },
                ],
              });
              if (saved && !signal.aborted) setEdit(null);
            } catch (cause) {
              if (!signal.aborted) setError(deliveryFailure(cause, zh));
            }
          }}
        >
          <strong>
            {zh ? "修改" : "Edit"} {editForSelection.sheet}!
            {editForSelection.cell}
          </strong>
          <small>
            {zh ? "基于版本" : "Based on"} {editForSelection.versionId}
          </small>
          {operationError && (
            <p className="delivery-edit-error">{operationError}</p>
          )}
          <label>
            {zh ? "值类型" : "Value type"}
            <select
              disabled={busy}
              value={editForSelection.kind}
              onChange={(event) =>
                setEdit({
                  ...editForSelection,
                  kind: event.target.value as DeliveryEditKind,
                })
              }
            >
              {(
                [
                  ["text", zh ? "文本" : "Text"],
                  ["number", zh ? "数字" : "Number"],
                  ["boolean", zh ? "布尔值" : "Boolean"],
                  ["empty", zh ? "清空" : "Clear"],
                  ["formula", zh ? "公式" : "Formula"],
                ] as const
              ).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {zh ? "新值" : "New value"}
            <input
              disabled={busy || editForSelection.kind === "empty"}
              value={editForSelection.value}
              onChange={(event) =>
                setEdit({ ...editForSelection, value: event.target.value })
              }
            />
          </label>
          <label>
            {zh ? "数字显示格式" : "Number display format"}
            <select
              disabled={busy}
              value={editForSelection.numberFormat}
              onChange={(event) =>
                setEdit({
                  ...editForSelection,
                  numberFormat: event.target.value as Edit["numberFormat"],
                })
              }
            >
              <option value="">
                {zh ? "保留当前格式" : "Keep current format"}
              </option>
              <option value="0">0</option>
              <option value="0.0">0.0</option>
              <option value="0.00">0.00</option>
            </select>
          </label>
          <div className="delivery-actions">
            <button disabled={busy} type="submit">
              {zh ? "保存新版本" : "Save new version"}
            </button>
            <button
              disabled={busy}
              type="button"
              onClick={async () => {
                const latest = await onReload(editForSelection.deliveryId);
                if (latest && !signal.aborted) {
                  setEdit({
                    ...editForSelection,
                    versionId: latest.versionId,
                    digest: latest.contentDigest,
                  });
                  onSelect({
                    ref: { kind: "version", id: latest.versionId },
                    record: latest,
                  });
                }
              }}
            >
              {zh ? "载入最新版本并保留编辑" : "Load latest, keep edit"}
            </button>
            <button disabled={busy} type="button" onClick={() => setEdit(null)}>
              {zh ? "取消编辑" : "Cancel edit"}
            </button>
          </div>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
