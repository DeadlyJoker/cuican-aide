import { useEffect, useRef, useState } from "react";
import type { DeliveryControlClient } from "@crewon/control-client";
import {
  DELIVERY_LIMITS,
  type DeliveryCatalog,
  type DeliveryInputRecord,
  type DeliveryVersionRecord,
} from "@crewon/domain/delivery";
import type { Locale } from "../../lib/i18n";
import { DeliveryAssembleForm } from "./DeliveryAssembleForm";
import { DeliveryPreview, type DeliverySelection } from "./DeliveryPreview";
import { deliveryFailure, deliveryUploadBytes } from "./deliveryUi";
import "./DeliveryPanel.css";

/** Remount the scope on task/client changes: pending responses cannot cross tasks. */
export function DeliveryPanel({
  client,
  threadId,
  locale,
}: {
  client: DeliveryControlClient | null;
  threadId: string;
  locale: Locale;
}) {
  const clientIdentity = useRef({ client, key: 0 });
  if (clientIdentity.current.client !== client)
    clientIdentity.current = { client, key: clientIdentity.current.key + 1 };
  if (!client)
    return (
      <p className="task-workbench-empty" role="status">
        {locale === "zh"
          ? "文件交付服务暂不可用。连接后可上传原件和模板。"
          : "File delivery is unavailable. Connect to upload source files and templates."}
      </p>
    );
  return (
    <DeliveryScope
      key={`${threadId}:${clientIdentity.current.key}`}
      client={client}
      threadId={threadId}
      locale={locale}
    />
  );
}

function DeliveryScope({
  client,
  threadId,
  locale,
}: {
  client: DeliveryControlClient;
  threadId: string;
  locale: Locale;
}) {
  const zh = locale === "zh";
  const [catalog, setCatalog] = useState<DeliveryCatalog | null>(null);
  const [selection, setSelection] = useState<DeliverySelection | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const scope = useRef(new AbortController());
  const operationLock = useRef(false);
  const catalogSequence = useRef(0);
  // A request that is retried with identical content retains its idempotency key.
  const pendingOperation = useRef<{ body: string; key: string } | null>(null);
  const operationKey = (body: unknown) => {
    const serialized = JSON.stringify(body);
    if (pendingOperation.current?.body !== serialized)
      pendingOperation.current = { body: serialized, key: crypto.randomUUID() };
    return pendingOperation.current.key;
  };
  async function refresh() {
    const sequence = ++catalogSequence.current;
    const next = await client.catalog(threadId, {
      signal: scope.current.signal,
    });
    if (!scope.current.signal.aborted && sequence === catalogSequence.current)
      setCatalog(next);
    return next;
  }
  async function refreshAfterSave() {
    try {
      await refresh();
    } catch (cause) {
      if (!scope.current.signal.aborted) setError(deliveryFailure(cause, zh));
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    void refresh()
      .catch((cause) => {
        if (!controller.signal.aborted) setError(deliveryFailure(cause, zh));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, threadId]);
  async function operation(action: () => Promise<void>): Promise<boolean> {
    if (operationLock.current) return false;
    operationLock.current = true;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await action();
      return !scope.current.signal.aborted;
    } catch (cause) {
      if (!scope.current.signal.aborted) setError(deliveryFailure(cause, zh));
      return false;
    } finally {
      if (!scope.current.signal.aborted) {
        setBusy(false);
        operationLock.current = false;
      }
    }
  }
  const selectVersion = (record: DeliveryVersionRecord) =>
    setSelection({ ref: { kind: "version", id: record.versionId }, record });
  async function upload(files: File[], role: DeliveryInputRecord["role"]) {
    await operation(async () => {
      if (files.length + (catalog?.inputs.length ?? 0) > DELIVERY_LIMITS.inputs)
        throw new Error(
          zh
            ? "每个任务最多保存 20 个输入文件"
            : "At most 20 input files per task",
        );
      let saved = 0;
      try {
        for (const file of files) {
          const body = await deliveryUploadBytes(file, role);
          if (scope.current.signal.aborted) return;
          const record = await client.upload(
            threadId,
            body,
            operationKey(body),
            { signal: scope.current.signal },
          );
          if (scope.current.signal.aborted) return;
          saved += 1;
          pendingOperation.current = null;
          setSelection({ ref: { kind: "input", id: record.inputId }, record });
        }
      } finally {
        if (!scope.current.signal.aborted) {
          await refresh();
          setStatus(
            zh ? `已保存 ${saved} 份原文件` : `${saved} source files saved`,
          );
        }
      }
    });
  }
  return (
    <section
      className="delivery-panel"
      aria-label={zh ? "文件交付" : "File delivery"}
      aria-busy={busy || loading}
    >
      <p>
        {zh
          ? "上传数据和 XLSX 模板，完整处理后保存可核对的表格。支持普通 XLSX；宏、外部链接、透视表等未支持结构会明确报错。"
          : "Upload data and an XLSX template to save verifiable spreadsheets. Ordinary XLSX is supported; unsupported macros, external links and pivots are reported."}
      </p>
      <div className="delivery-upload-actions">
        <label>
          {zh ? "添加数据 CSV / XLSX" : "Add CSV / XLSX data"}
          <input
            aria-label={zh ? "上传数据文件" : "Upload data files"}
            disabled={busy || loading}
            type="file"
            accept=".csv,.xlsx"
            multiple
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (files.length) void upload(files, "data");
            }}
          />
        </label>
        <label>
          {zh ? "添加 XLSX 模板" : "Add XLSX template"}
          <input
            aria-label={zh ? "上传 XLSX 模板" : "Upload XLSX template"}
            disabled={busy || loading}
            type="file"
            accept=".xlsx"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (files.length) void upload(files, "template");
            }}
          />
        </label>
        <button
          type="button"
          disabled={busy || loading}
          onClick={() =>
            void operation(async () => {
              await refresh();
            })
          }
        >
          {zh ? "刷新目录" : "Refresh files"}
        </button>
      </div>
      {loading && (
        <p role="status">
          {zh ? "正在读取已保存文件…" : "Loading saved files…"}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
      <div className="delivery-catalog">
        <h3>
          {zh ? "原件与模板" : "Sources and templates"}{" "}
          <small>{catalog?.inputs.length ?? 0} / 20</small>
        </h3>
        {catalog?.inputs.map((record) => (
          <button
            type="button"
            disabled={busy}
            key={record.inputId}
            aria-pressed={selection?.ref.id === record.inputId}
            onClick={() =>
              setSelection({
                ref: { kind: "input", id: record.inputId },
                record,
              })
            }
          >
            <strong>{record.name}</strong>
            <small>
              {record.role === "template"
                ? zh
                  ? "模板"
                  : "Template"
                : zh
                  ? "数据"
                  : "Data"}{" "}
              · {record.inspection.sheets.length} {zh ? "张工作表" : "sheets"} ·{" "}
              {record.byteLength.toLocaleString()} B
            </small>
          </button>
        ))}
        <h3>
          {zh ? "已保存交付" : "Saved deliveries"}{" "}
          <small>{catalog?.deliveries.length ?? 0}</small>
        </h3>
        {catalog?.deliveries.map((record) => (
          <button
            type="button"
            disabled={busy}
            key={record.deliveryId}
            aria-pressed={selection?.ref.id === record.versionId}
            onClick={() => selectVersion(record)}
          >
            <strong>{record.name}</strong>
            <small>
              {zh ? "已验证" : "Verified"} ·{" "}
              {new Date(record.createdAt).toLocaleString(
                zh ? "zh-CN" : "en-US",
              )}{" "}
              · {record.validation.writtenRows} {zh ? "行" : "rows"}
            </small>
          </button>
        ))}
        {!catalog?.deliveries.length && (
          <p>
            {zh
              ? "尚无已保存文件。生成成功后会显示在这里。"
              : "No saved files yet. Successful deliveries appear here."}
          </p>
        )}
      </div>
      <DeliveryAssembleForm
        client={client}
        threadId={threadId}
        inputs={catalog?.inputs ?? []}
        busy={busy || loading}
        zh={zh}
        onAssemble={(request) =>
          void operation(async () => {
            const version = await client.assemble(
              threadId,
              request,
              operationKey(request),
              { signal: scope.current.signal },
            );
            if (scope.current.signal.aborted) return;
            pendingOperation.current = null;
            selectVersion(version);
            setStatus(zh ? "XLSX 已验证并保存" : "XLSX verified and saved");
            await refreshAfterSave();
          })
        }
      />
      {selection && (
        <DeliveryPreview
          client={client}
          threadId={threadId}
          selection={selection}
          busy={busy}
          zh={zh}
          signal={scope.current.signal}
          operationError={error}
          inputNames={Object.fromEntries(
            (catalog?.inputs ?? []).map((input) => [input.inputId, input.name]),
          )}
          onSelect={setSelection}
          onPatch={(request) =>
            operation(async () => {
              const version = await client.patch(
                threadId,
                request,
                operationKey(request),
                { signal: scope.current.signal },
              );
              if (scope.current.signal.aborted) return;
              pendingOperation.current = null;
              selectVersion(version);
              setStatus(zh ? "新版本已保存" : "New version saved");
              await refreshAfterSave();
            })
          }
          onReload={async (deliveryId) => {
            let latest: DeliveryVersionRecord | null = null;
            await operation(async () => {
              const next = await refresh();
              latest =
                next.deliveries.find((v) => v.deliveryId === deliveryId) ??
                null;
              if (!latest) throw new Error("delivery_not_found");
            });
            return latest;
          }}
        />
      )}
    </section>
  );
}
