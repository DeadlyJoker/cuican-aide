import { useEffect, useRef, useState } from "react";
import type { DeliveryControlClient } from "@crewon/control-client";
import type {
  DeliveryAssembleRequest,
  DeliveryInputRecord,
  DeliverySourceSelection,
  DeliveryColumnMapping,
} from "@crewon/domain/delivery";
import { deliveryColumn, deliveryFailure } from "./deliveryUi";

export function DeliveryAssembleForm({
  client,
  threadId,
  inputs,
  busy,
  zh,
  onAssemble,
}: {
  client: DeliveryControlClient;
  threadId: string;
  inputs: readonly DeliveryInputRecord[];
  busy: boolean;
  zh: boolean;
  onAssemble: (request: DeliveryAssembleRequest) => void;
}) {
  const templates = inputs.filter((input) => input.role === "template");
  const [templateId, setTemplateId] = useState("");
  const [targetSheet, setTargetSheet] = useState("");
  const [startRow, setStartRow] = useState(2);
  const [name, setName] = useState("汇集结果.xlsx");
  const [sources, setSources] = useState<DeliverySourceSelection[]>([]);
  const [columns, setColumns] = useState<DeliveryColumnMapping[]>([]);
  const [mappingBusy, setMappingBusy] = useState(false);
  const [error, setError] = useState("");
  const [rulesEnabled, setRulesEnabled] = useState(false);
  const [excludeHeader, setExcludeHeader] = useState("status");
  const [excludeValue, setExcludeValue] = useState("canceled");
  const [requiredHeaders, setRequiredHeaders] = useState("amount");
  const [exceptionSheet, setExceptionSheet] = useState("异常");
  const [lineageSheet, setLineageSheet] = useState("来源");
  const [summarySheet, setSummarySheet] = useState("汇总");
  const [summaryStartRow, setSummaryStartRow] = useState(2);
  const [groupBy, setGroupBy] = useState("channel,currency");
  const [valueHeader, setValueHeader] = useState("amount");
  const mappingRequest = useRef<AbortController | null>(null);
  const template =
    templates.find((input) => input.inputId === templateId) ?? templates[0];
  const sheet =
    template?.inspection.sheets.find((s) => s.name === targetSheet)?.name ??
    template?.inspection.sheets[0]?.name ??
    "";
  useEffect(() => () => mappingRequest.current?.abort(), []);
  function invalidateMapping() {
    mappingRequest.current?.abort();
    setMappingBusy(false);
    setColumns([]);
    setError("");
  }
  async function matchHeaders() {
    if (!template || !sources[0]) return;
    mappingRequest.current?.abort();
    const request = new AbortController();
    mappingRequest.current = request;
    setMappingBusy(true);
    setError("");
    try {
      const [source, destination] = await Promise.all([
        client.page(
          threadId,
          { kind: "input", id: sources[0].inputId },
          { sheet: sources[0].sheet, startRow: sources[0].headerRow, limit: 1 },
          { signal: request.signal },
        ),
        client.page(
          threadId,
          { kind: "input", id: template.inputId },
          { sheet, startRow: Math.max(1, startRow - 1), limit: 1 },
          { signal: request.signal },
        ),
      ]);
      if (request.signal.aborted) return;
      const headers = source.rows[0] ?? [];
      const mapping = (destination.rows[0] ?? []).flatMap((header, index) =>
        typeof header === "string" &&
        header.length > 0 &&
        headers.includes(header)
          ? [{ sourceHeader: header, targetColumn: deliveryColumn(index) }]
          : [],
      );
      setColumns(mapping);
      if (!mapping.length)
        setError(
          zh
            ? "未找到同名表头，请手工添加映射。"
            : "No matching headers. Add mappings manually.",
        );
    } catch (cause) {
      if (!request.signal.aborted) setError(deliveryFailure(cause, zh));
    } finally {
      if (!request.signal.aborted) setMappingBusy(false);
    }
  }
  return (
    <details className="delivery-assemble">
      <summary>{zh ? "按模板汇集数据" : "Assemble with a template"}</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (template)
            onAssemble({
              templateInputId: template.inputId,
              name,
              sources,
              columns,
              targetSheet: sheet,
              startRow,
              ...(rulesEnabled
                ? {
                    rules: {
                      exclude: excludeHeader.trim()
                        ? [
                            {
                              header: excludeHeader.trim(),
                              equals: excludeValue,
                            },
                          ]
                        : [],
                      requiredHeaders: requiredHeaders
                        .split(/[,，]/u)
                        .map((s) => s.trim())
                        .filter(Boolean),
                      exceptionSheet,
                      lineageSheet,
                      summary: {
                        sheet: summarySheet,
                        startRow: summaryStartRow,
                        groupBy: groupBy
                          .split(/[,，]/u)
                          .map((s) => s.trim())
                          .filter(Boolean),
                        valueHeader,
                      },
                    },
                  }
                : {}),
            });
        }}
      >
        <fieldset disabled={busy || mappingBusy}>
          <legend>
            {zh ? "选择完整来源范围" : "Select complete source ranges"}
          </legend>
          {inputs
            .filter((input) => input.role === "data")
            .map((input) => (
              <div key={input.inputId} className="delivery-source-file">
                <strong>{input.name}</strong>
                {input.inspection.sheets.map((sourceSheet) => {
                  const selected = sources.find(
                    (source) =>
                      source.inputId === input.inputId &&
                      source.sheet === sourceSheet.name,
                  );
                  return (
                    <div className="delivery-source-row" key={sourceSheet.name}>
                      <label>
                        <input
                          type="checkbox"
                          checked={Boolean(selected)}
                          onChange={(event) => {
                            invalidateMapping();
                            setSources((current) =>
                              event.target.checked
                                ? [
                                    ...current,
                                    {
                                      inputId: input.inputId,
                                      sheet: sourceSheet.name,
                                      headerRow: 1,
                                    },
                                  ]
                                : current.filter(
                                    (source) =>
                                      source.inputId !== input.inputId ||
                                      source.sheet !== sourceSheet.name,
                                  ),
                            );
                          }}
                        />
                        {sourceSheet.name} · {sourceSheet.rows} ×{" "}
                        {sourceSheet.columns}
                      </label>
                      {selected && (
                        <label>
                          {zh ? "表头行" : "Header row"}
                          <input
                            aria-label={`${input.name} ${sourceSheet.name} ${zh ? "表头行" : "header row"}`}
                            type="number"
                            min={1}
                            max={Math.max(1, sourceSheet.rows)}
                            value={selected.headerRow}
                            onChange={(event) => {
                              invalidateMapping();
                              setSources((current) =>
                                current.map((source) =>
                                  source === selected
                                    ? {
                                        ...source,
                                        headerRow: Number(event.target.value),
                                      }
                                    : source,
                                ),
                              );
                            }}
                          />
                        </label>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          {!inputs.some((input) => input.role === "data") && (
            <p>{zh ? "先上传数据文件。" : "Upload data files first."}</p>
          )}
          <label>
            {zh ? "XLSX 模板" : "XLSX template"}
            <select
              required
              value={template?.inputId ?? ""}
              onChange={(event) => {
                invalidateMapping();
                setTemplateId(event.target.value);
                setTargetSheet("");
              }}
            >
              {!templates.length && (
                <option value="">
                  {zh ? "先上传模板" : "Upload a template"}
                </option>
              )}
              {templates.map((input) => (
                <option key={input.inputId} value={input.inputId}>
                  {input.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {zh ? "目标工作表" : "Target sheet"}
            <select
              required
              value={sheet}
              onChange={(event) => {
                invalidateMapping();
                setTargetSheet(event.target.value);
              }}
            >
              {template?.inspection.sheets.map((s) => (
                <option key={s.name}>{s.name}</option>
              ))}
            </select>
          </label>
          <label>
            {zh ? "数据起始行" : "First data row"}
            <input
              type="number"
              min={1}
              max={100000}
              required
              value={startRow}
              onChange={(event) => {
                invalidateMapping();
                setStartRow(Number(event.target.value));
              }}
            />
          </label>
          <p>
            {zh
              ? "同名匹配读取第一份已选来源的表头，以及目标起始行的上一行；汇集会读取每份来源表头后的全部行。"
              : "Matching uses the first selected source header and the row before the target start. Assembly processes all rows after each source header."}
          </p>
          <button
            type="button"
            disabled={!template || !sources.length}
            onClick={() => void matchHeaders()}
          >
            {zh ? "同名表头匹配" : "Match headers"}
          </button>
          {columns.map((mapping, index) => (
            <div className="delivery-column-row" key={index}>
              <label>
                {zh ? "来源表头" : "Source header"}
                <input
                  required
                  value={mapping.sourceHeader}
                  onChange={(event) =>
                    setColumns((current) =>
                      current.map((c, i) =>
                        i === index
                          ? { ...c, sourceHeader: event.target.value }
                          : c,
                      ),
                    )
                  }
                />
              </label>
              <label>
                {zh ? "目标列" : "Target column"}
                <input
                  required
                  pattern="[A-Z]{1,3}"
                  value={mapping.targetColumn}
                  onChange={(event) =>
                    setColumns((current) =>
                      current.map((c, i) =>
                        i === index
                          ? {
                              ...c,
                              targetColumn: event.target.value.toUpperCase(),
                            }
                          : c,
                      ),
                    )
                  }
                />
              </label>
              <button
                type="button"
                aria-label={
                  zh ? `移除映射 ${index + 1}` : `Remove mapping ${index + 1}`
                }
                onClick={() =>
                  setColumns((current) => current.filter((_, i) => i !== index))
                }
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              setColumns((current) => [
                ...current,
                {
                  sourceHeader: "",
                  targetColumn: deliveryColumn(current.length),
                },
              ])
            }
          >
            {zh ? "添加列映射" : "Add mapping"}
          </button>
          <label>
            <span>
              <input
                type="checkbox"
                checked={rulesEnabled}
                onChange={(event) => setRulesEnabled(event.target.checked)}
              />{" "}
              {zh
                ? "筛选、异常与分组汇总"
                : "Filter, exceptions and grouped totals"}
            </span>
          </label>
          {rulesEnabled && (
            <div className="delivery-rule-fields">
              <p>
                {zh
                  ? "满足排除条件的行跳过；缺失必填值的行写入异常表。汇总和来源写入模板中的指定工作表。"
                  : "Matching rows are excluded. Missing required values go to exceptions. Totals and lineage use the specified template sheets."}
              </p>
              <label>
                {zh
                  ? "排除条件表头（留空不排除）"
                  : "Exclude header (optional)"}
                <input
                  value={excludeHeader}
                  onChange={(event) => setExcludeHeader(event.target.value)}
                />
              </label>
              <label>
                {zh ? "排除条件等于文本" : "Exclude value equals text"}
                <input
                  value={excludeValue}
                  onChange={(event) => setExcludeValue(event.target.value)}
                />
              </label>
              <label>
                {zh
                  ? "必填表头（逗号分隔）"
                  : "Required headers (comma separated)"}
                <input
                  value={requiredHeaders}
                  onChange={(event) => setRequiredHeaders(event.target.value)}
                />
              </label>
              <label>
                {zh ? "异常工作表" : "Exception sheet"}
                <input
                  required
                  value={exceptionSheet}
                  onChange={(event) => setExceptionSheet(event.target.value)}
                />
              </label>
              <label>
                {zh ? "来源工作表" : "Lineage sheet"}
                <input
                  required
                  value={lineageSheet}
                  onChange={(event) => setLineageSheet(event.target.value)}
                />
              </label>
              <label>
                {zh ? "汇总工作表" : "Summary sheet"}
                <input
                  required
                  value={summarySheet}
                  onChange={(event) => setSummarySheet(event.target.value)}
                />
              </label>
              <label>
                {zh ? "汇总起始行" : "Summary start row"}
                <input
                  type="number"
                  min={1}
                  max={100000}
                  required
                  value={summaryStartRow}
                  onChange={(event) =>
                    setSummaryStartRow(Number(event.target.value))
                  }
                />
              </label>
              <label>
                {zh
                  ? "分组表头（逗号分隔）"
                  : "Group headers (comma separated)"}
                <input
                  required
                  value={groupBy}
                  onChange={(event) => setGroupBy(event.target.value)}
                />
              </label>
              <label>
                {zh ? "求和表头" : "Sum header"}
                <input
                  required
                  value={valueHeader}
                  onChange={(event) => setValueHeader(event.target.value)}
                />
              </label>
            </div>
          )}
          <label>
            {zh ? "交付文件名" : "Output filename"}
            <input
              required
              maxLength={255}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <button
            type="submit"
            disabled={!template || !sources.length || !columns.length}
          >
            {zh ? "生成并保存 XLSX" : "Create and save XLSX"}
          </button>
        </fieldset>
        {mappingBusy && (
          <p role="status">{zh ? "正在读取表头…" : "Reading headers…"}</p>
        )}
        {error && <p role="alert">{error}</p>}
      </form>
    </details>
  );
}
