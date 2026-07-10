import { useEffect, useMemo, useState } from "react";
import { Download, LoaderCircle, Play, RefreshCw, X } from "lucide-react";

import {
  downloadCatalogResource,
  invokeCatalogAgent,
  invokeCatalogMcpTool,
  invokeCatalogSkill,
  readCatalogResourceDetail,
  searchCatalogKnowledge,
  type CatalogResourceDetail,
  type CatalogResourceSummary,
} from "../../lib/agent-platform/agentPlatformCatalog";

function jsonText(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${label}必须是 JSON 对象`);
  }
  return parsed as Record<string, unknown>;
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Skill 参数必须是字符串数组，例如 [\"--help\"]");
  }
  return parsed;
}

function scriptPaths(detail: CatalogResourceDetail): string[] {
  const files = detail.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) return [];
  const tree = (files as { file_tree?: unknown }).file_tree;
  if (!Array.isArray(tree)) return [];
  return tree.filter(
    (path): path is string =>
      typeof path === "string" && /(^|\/)scripts?\/.*\.(py|js|mjs|sh|ps1)$/i.test(path),
  );
}

function resourceFacts(resource: CatalogResourceSummary): string[] {
  if (resource.type === "agents") {
    return [
      resource.model || "未配置模型",
      resource.api_enabled ? "API 已开放" : "目录调用",
    ];
  }
  if (resource.type === "skills") {
    return [
      `${resource.file_count ?? 0} 个文件`,
      resource.has_scripts ? "含脚本" : "声明式 Skill",
    ];
  }
  if (resource.type === "mcp_servers") {
    return [
      `${resource.tool_count ?? 0} 个工具`,
      resource.connected ? "已连接" : "可调用服务",
    ];
  }
  return [
    `${resource.document_count ?? 0} 篇文档`,
    `${resource.chunk_count ?? 0} 个分块`,
  ];
}

export function CatalogResourceDialog({
  resource,
  onClose,
  onRefresh,
}: {
  resource: CatalogResourceSummary | null;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<CatalogResourceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<
    "download" | "invoke" | "refresh" | null
  >(null);
  const [progress, setProgress] = useState(0);
  const [query, setQuery] = useState("请介绍你的能力，并给出一个可执行示例。");
  const [skillScript, setSkillScript] = useState("");
  const [skillArgs, setSkillArgs] = useState("[]");
  const [mcpToolId, setMcpToolId] = useState("");
  const [mcpArguments, setMcpArguments] = useState("{}");
  const [knowledgeTopK, setKnowledgeTopK] = useState(5);
  const [result, setResult] = useState<unknown>(null);

  useEffect(() => {
    if (!resource) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setError(null);
    setDetail(null);
    setResult(null);
    readCatalogResourceDetail(resource.type, resource.id).then(
      (value) => {
        if (!cancelled) {
          setDetail(value);
          const scripts = scriptPaths(value);
          setSkillScript(scripts[0] ?? "");
          setMcpToolId(String(value.tools?.[0]?.id ?? ""));
        }
      },
      (reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : "详情加载失败");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [resource]);

  const facts = useMemo(
    () => (resource ? resourceFacts(resource) : []),
    [resource],
  );
  if (!resource) return null;
  const activeResource = resource;

  async function download() {
    setOperation("download");
    setProgress(2);
    setError(null);
    try {
      const downloadResult = await downloadCatalogResource(
        activeResource.type,
        activeResource.id,
        activeResource.name,
        setProgress,
      );
      const url = URL.createObjectURL(downloadResult.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = downloadResult.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "下载失败");
    } finally {
      setOperation(null);
    }
  }

  async function refresh() {
    setOperation("refresh");
    setProgress(35);
    setError(null);
    try {
      await onRefresh();
      setProgress(100);
      setDetail(
        await readCatalogResourceDetail(activeResource.type, activeResource.id),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "更新失败");
    } finally {
      setOperation(null);
    }
  }

  async function invoke() {
    setOperation("invoke");
    setProgress(45);
    setError(null);
    setResult(null);
    try {
      let response: unknown;
      if (activeResource.type === "agents") {
        if (!query.trim()) throw new Error("请输入 Agent 参数");
        response = await invokeCatalogAgent(activeResource.id, query.trim());
      } else if (activeResource.type === "skills") {
        if (!skillScript.trim()) throw new Error("请选择或填写 Skill 脚本路径");
        response = await invokeCatalogSkill(
          activeResource.id,
          skillScript.trim(),
          parseStringArray(skillArgs),
        );
      } else if (activeResource.type === "mcp_servers") {
        const toolId = Number(mcpToolId);
        if (!Number.isInteger(toolId)) throw new Error("请选择 MCP Tool");
        response = await invokeCatalogMcpTool(
          activeResource.id,
          toolId,
          parseJsonObject(mcpArguments, "MCP 参数"),
        );
      } else {
        if (!query.trim()) throw new Error("请输入知识库检索问题");
        response = await searchCatalogKnowledge(
          activeResource.id,
          query.trim(),
          knowledgeTopK,
        );
      }
      setProgress(100);
      setResult(response);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "资源调用失败");
    } finally {
      setOperation(null);
    }
  }

  return (
    <div
      className="catalog-resource-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        aria-labelledby="catalog-resource-title"
        aria-modal="true"
        className="catalog-resource-dialog"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="catalog-resource-dialog-head">
          <div>
            <span>
              {resource.owner_username || "agent-platform"} · {resource.type}
            </span>
            <h2 id="catalog-resource-title">{resource.name}</h2>
            <p>{resource.description || "暂无描述"}</p>
          </div>
          <button
            className="icon-action compact"
            type="button"
            aria-label="关闭详情"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="catalog-resource-facts">
          {facts.map((fact) => (
            <span key={fact}>{fact}</span>
          ))}
        </div>

        <div className="catalog-resource-actions">
          <button
            className="button"
            disabled={Boolean(operation)}
            type="button"
            onClick={refresh}
          >
            <RefreshCw
              className={operation === "refresh" ? "spin" : undefined}
              aria-hidden="true"
            />
            更新
          </button>
          <button
            className="button primary"
            disabled={Boolean(operation)}
            type="button"
            onClick={download}
          >
            <Download aria-hidden="true" />
            下载
          </button>
        </div>

        {operation ? (
          <div className="catalog-operation-progress" aria-live="polite">
            <span>
              <LoaderCircle className="spin" aria-hidden="true" />
              {operation === "download"
                ? "正在下载"
                : operation === "refresh"
                  ? "正在更新"
                  : "正在调用"}
            </span>
            <progress max="100" value={progress} />
          </div>
        ) : null}
        {error ? (
          <p className="catalog-resource-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="catalog-resource-detail-body">
          {!detail && !error ? (
            <p className="catalog-resource-loading">正在读取完整详情…</p>
          ) : null}

          {resource.type === "agents" && detail ? (
            <>
              <section>
                <h3>接口与出入参</h3>
                <pre>{jsonText(detail.invocation)}</pre>
              </section>
              <section className="catalog-resource-runner">
                <h3>调用 Agent</h3>
                <textarea
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <button
                  className="button primary"
                  disabled={Boolean(operation)}
                  type="button"
                  onClick={invoke}
                >
                  <Play aria-hidden="true" />
                  执行
                </button>
              </section>
            </>
          ) : null}

          {resource.type === "skills" && detail ? (
            <>
              <section>
                <h3>SKILL.md</h3>
                <pre>
                  {typeof detail.skill_md === "string"
                    ? detail.skill_md
                    : jsonText(detail.skill_md)}
                </pre>
              </section>
              <section>
                <h3>文件结构</h3>
                <pre>{jsonText(detail.files)}</pre>
              </section>
              <section className="catalog-resource-runner">
                <h3>执行 Skill</h3>
                <label>
                  <span>脚本路径</span>
                  <input
                    list="catalog-skill-scripts"
                    value={skillScript}
                    onChange={(event) => setSkillScript(event.target.value)}
                  />
                  <datalist id="catalog-skill-scripts">
                    {scriptPaths(detail).map((path) => (
                      <option key={path} value={path} />
                    ))}
                  </datalist>
                </label>
                <label>
                  <span>参数（JSON 字符串数组）</span>
                  <textarea
                    value={skillArgs}
                    onChange={(event) => setSkillArgs(event.target.value)}
                  />
                </label>
                <button
                  className="button primary"
                  disabled={Boolean(operation)}
                  type="button"
                  onClick={invoke}
                >
                  <Play aria-hidden="true" />
                  执行 Skill
                </button>
              </section>
            </>
          ) : null}

          {resource.type === "mcp_servers" && detail ? (
            <>
              <section>
                <h3>MCP 工具与 Schema</h3>
                <pre>{jsonText(detail.tools)}</pre>
              </section>
              <section className="catalog-resource-runner">
                <h3>调用 MCP Tool</h3>
                <label>
                  <span>工具</span>
                  <select
                    value={mcpToolId}
                    onChange={(event) => setMcpToolId(event.target.value)}
                  >
                    {(detail.tools ?? []).map((tool, index) => (
                      <option
                        key={String(tool.id ?? index)}
                        value={String(tool.id ?? "")}
                      >
                        {String(tool.name ?? tool.alias ?? `Tool ${index + 1}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>调用参数（JSON）</span>
                  <textarea
                    value={mcpArguments}
                    onChange={(event) => setMcpArguments(event.target.value)}
                  />
                </label>
                <button
                  className="button primary"
                  disabled={Boolean(operation)}
                  type="button"
                  onClick={invoke}
                >
                  <Play aria-hidden="true" />
                  调用 Tool
                </button>
              </section>
            </>
          ) : null}

          {resource.type === "knowledge_bases" && detail ? (
            <>
              <section>
                <h3>完整知识文档</h3>
                <div className="catalog-document-list">
                  {(detail.documents ?? []).map((document, index) => {
                    const chunks = Array.isArray(document.chunks)
                      ? document.chunks
                      : [];
                    return (
                      <details key={String(document.id ?? index)}>
                        <summary>
                          <strong>
                            {String(
                              document.title ??
                                document.name ??
                                `文档 ${index + 1}`,
                            )}
                          </strong>
                          <span>{chunks.length} 个分块</span>
                        </summary>
                        <pre>{jsonText(document)}</pre>
                      </details>
                    );
                  })}
                </div>
              </section>
              <section className="catalog-resource-runner">
                <h3>检索知识库</h3>
                <textarea
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <label>
                  <span>返回条数</span>
                  <input
                    max={20}
                    min={1}
                    type="number"
                    value={knowledgeTopK}
                    onChange={(event) =>
                      setKnowledgeTopK(Number(event.target.value))
                    }
                  />
                </label>
                <button
                  className="button primary"
                  disabled={Boolean(operation)}
                  type="button"
                  onClick={invoke}
                >
                  <Play aria-hidden="true" />
                  开始检索
                </button>
              </section>
            </>
          ) : null}

          {result ? (
            <section>
              <h3>调用结果</h3>
              <pre>{jsonText(result)}</pre>
            </section>
          ) : null}
        </div>
      </section>
    </div>
  );
}
