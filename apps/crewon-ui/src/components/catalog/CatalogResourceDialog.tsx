import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  Download,
  Eye,
  FileCode2,
  FileText,
  Folder,
  LoaderCircle,
  RefreshCw,
  UserPlus,
  X,
} from "lucide-react";

import { renderMarkdown } from "../TranscriptMarkdown";
import {
  callCatalogMcpTool,
  downloadCatalogResource,
  readCatalogResourceDetail,
  readCatalogSkillFile,
  type CatalogResourceDetail,
  type CatalogResourceSummary,
  type CatalogSkillFile,
} from "../../lib/agent-platform/agentPlatformCatalog";

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject {
  return value && !Array.isArray(value) && typeof value === "object"
    ? (value as JsonObject)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function displayType(value: unknown): string {
  if (Array.isArray(value)) return value.join(" | ");
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return "object";
  return "any";
}

function schemaRows(schemaValue: unknown) {
  const schema = objectValue(schemaValue);
  const properties = objectValue(schema.properties);
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  return Object.entries(properties).map(([name, definition]) => {
    const field = objectValue(definition);
    return {
      name,
      type: displayType(field.type),
      required: required.includes(name),
      description: stringValue(field.description),
    };
  });
}

function SchemaTable({ schema }: { schema: unknown }) {
  const rows = schemaRows(schema);
  if (rows.length === 0) {
    return <p className="catalog-empty-copy">无额外字段</p>;
  }
  return (
    <div className="catalog-schema-table" role="table">
      <div className="catalog-schema-row catalog-schema-head" role="row">
        <span>字段</span>
        <span>类型</span>
        <span>要求</span>
        <span>说明</span>
      </div>
      {rows.map((row) => (
        <div className="catalog-schema-row" key={row.name} role="row">
          <code>{row.name}</code>
          <span>{row.type}</span>
          <span>{row.required ? "必填" : "可选"}</span>
          <span>{row.description || "-"}</span>
        </div>
      ))}
    </div>
  );
}

const mcpCallResponseSchema = {
  type: "object",
  required: ["tool_id", "tool_name", "result", "session_id"],
  properties: {
    tool_id: { type: "integer", description: "平台 Tool ID" },
    tool_name: { type: "string", description: "MCP Tool 名称" },
    result: { type: "object", description: "MCP ToolResult" },
    session_id: { type: "string", description: "本次调用会话 ID" },
  },
};

const mcpToolResultSchema = {
  type: "object",
  properties: {
    content: {
      type: "array",
      description: "文本、图片、音频或资源内容",
    },
    structuredContent: {
      type: "object",
      description: "工具返回的结构化数据",
    },
    isError: { type: "boolean", description: "工具是否返回执行错误" },
  },
};

function declaredMcpOutputSchema(tool: JsonObject): unknown | null {
  const candidates = [tool.output_schema, objectValue(tool.invocation).output];
  return (
    candidates.find((candidate) => schemaRows(candidate).length > 0) ?? null
  );
}

function defaultSchemaValue(schemaValue: unknown): unknown {
  const schema = objectValue(schemaValue);
  const type = stringValue(schema.type);
  if (type === "boolean") return false;
  if (type === "integer" || type === "number") return 0;
  if (type === "array") return [];
  if (type === "object") return {};
  return "";
}

function initialToolArguments(tool: JsonObject): Record<string, unknown> {
  const schema = objectValue(
    tool.input_schema ?? objectValue(tool.invocation).input ?? tool.schema,
  );
  return Object.fromEntries(
    Object.entries(objectValue(schema.properties)).map(([name, definition]) => [
      name,
      defaultSchemaValue(definition),
    ]),
  );
}

function skillMarkdown(detail: CatalogResourceDetail): string {
  if (typeof detail.skill_md === "string") return detail.skill_md;
  const skillMd = objectValue(detail.skill_md);
  return (
    stringValue(skillMd.content) ||
    stringValue(detail.skill_md_content) ||
    stringValue(detail.content)
  );
}

function markdownBody(value: string): string {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return value;
  const closingIndex = lines
    .slice(1)
    .findIndex((line) => line.trim() === "---");
  return closingIndex < 0 ? value : lines.slice(closingIndex + 2).join("\n");
}

function documentTitle(document: JsonObject, index: number): string {
  return (
    stringValue(document.title) ||
    stringValue(document.name) ||
    stringValue(document.filename) ||
    `文档 ${index + 1}`
  );
}

function documentContent(document: JsonObject): string {
  const direct =
    stringValue(document.content) ||
    stringValue(document.text) ||
    stringValue(document.markdown) ||
    stringValue(document.parsed_content);
  if (direct) return direct;
  const chunks = Array.isArray(document.chunks) ? document.chunks : [];
  return chunks
    .map((chunk) => {
      const value = objectValue(chunk);
      return stringValue(value.content) || stringValue(value.text);
    })
    .filter(Boolean)
    .join("\n\n");
}

export function AgentDetail({ detail }: { detail: CatalogResourceDetail }) {
  const active = detail.is_active !== false && detail.is_active !== 0;
  const apiEnabled = detail.api_enabled === true || detail.api_enabled === 1;
  return (
    <div className="catalog-detail-document">
      <section>
        <h3>能力说明</h3>
        <p>
          {stringValue(detail.description) || "该 Agent 暂未提供补充说明。"}
        </p>
      </section>
      <section>
        <h3>配置状态</h3>
        <dl className="catalog-contract-list">
          <div>
            <dt>模式</dt>
            <dd>{active ? "可用" : "已停用"}</dd>
          </div>
          <div>
            <dt>运行</dt>
            <dd>{apiEnabled ? "Open API 已启用" : "Open API 未启用"}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

export function SkillDetail({
  detail,
  resource,
}: {
  detail: CatalogResourceDetail;
  resource: CatalogResourceSummary;
}) {
  const [listing, setListing] = useState<CatalogSkillFile | null>(null);
  const [selectedFile, setSelectedFile] = useState<CatalogSkillFile | null>(
    null,
  );
  const [fileError, setFileError] = useState<string | null>(null);
  const markdown = markdownBody(skillMarkdown(detail));

  useEffect(() => {
    if (resource.source === "catalog" && !resource.downloaded) {
      setListing(null);
      setSelectedFile(null);
      setFileError(null);
      return;
    }
    let cancelled = false;
    readCatalogSkillFile(resource).then(
      (value) => !cancelled && setListing(value),
      (reason: unknown) =>
        !cancelled &&
        setFileError(
          reason instanceof Error ? reason.message : "文件目录读取失败",
        ),
    );
    return () => {
      cancelled = true;
    };
  }, [resource]);

  async function openPath(path: string, type: "directory" | "file") {
    setFileError(null);
    try {
      const value = await readCatalogSkillFile(resource, path);
      if (type === "directory") {
        setListing(value);
        setSelectedFile(null);
      } else {
        setSelectedFile(value);
      }
    } catch (reason) {
      setFileError(reason instanceof Error ? reason.message : "文件读取失败");
    }
  }

  const parentPath = listing?.path.includes("/")
    ? listing.path.split("/").slice(0, -1).join("/")
    : "";
  return (
    <div className="catalog-skill-reader">
      <aside className="catalog-file-browser">
        <header>
          <strong>文件</strong>
          {listing?.path ? (
            <button
              type="button"
              aria-label="返回上一级"
              onClick={() => openPath(parentPath, "directory")}
            >
              <ChevronLeft aria-hidden="true" />
            </button>
          ) : null}
        </header>
        {fileError ? <p role="alert">{fileError}</p> : null}
        {resource.source === "catalog" && !resource.downloaded ? (
          <p>下载 Skill 后可浏览完整文件树</p>
        ) : null}
        <div>
          {(listing?.items ?? []).map((item) => (
            <button
              key={item.path}
              type="button"
              onClick={() => openPath(item.path, item.type)}
            >
              {item.type === "directory" ? (
                <Folder aria-hidden="true" />
              ) : (
                <FileCode2 aria-hidden="true" />
              )}
              <span>{item.name}</span>
            </button>
          ))}
        </div>
      </aside>
      <article className="catalog-reader-content">
        {selectedFile?.type === "file" ? (
          <>
            <header>
              <FileText aria-hidden="true" />
              <strong>{selectedFile.path}</strong>
            </header>
            {/\.md$/i.test(selectedFile.path) ? (
              renderMarkdown(selectedFile.content ?? "")
            ) : (
              <pre>
                <code>{selectedFile.content ?? ""}</code>
              </pre>
            )}
          </>
        ) : markdown ? (
          renderMarkdown(markdown)
        ) : (
          <p className="catalog-empty-copy">暂无技能文档</p>
        )}
      </article>
    </div>
  );
}

export function McpDetail({
  detail,
  resource,
}: {
  detail: CatalogResourceDetail;
  resource: CatalogResourceSummary;
}) {
  const [toolInputs, setToolInputs] = useState<Record<string, string>>({});
  const [toolResults, setToolResults] = useState<Record<string, unknown>>({});
  const [toolErrors, setToolErrors] = useState<Record<string, string>>({});
  const [busyTool, setBusyTool] = useState<string | null>(null);
  const tools = Array.isArray(detail.tools)
    ? detail.tools.map(objectValue)
    : [];
  const endpoint =
    stringValue(detail.endpoint) ||
    stringValue(detail.url) ||
    stringValue(objectValue(detail.invocation).url);
  const upstreamUrl = stringValue(detail.url);

  async function callTool(tool: JsonObject, index: number) {
    const toolId = Number(tool.id);
    const key = String(tool.id ?? tool.name ?? index);
    if (!Number.isInteger(toolId) || toolId <= 0) {
      setToolErrors((current) => ({
        ...current,
        [key]: "该工具缺少可调用的 Tool ID",
      }));
      return;
    }
    const rawArguments =
      toolInputs[key] ?? JSON.stringify(initialToolArguments(tool), null, 2);
    let argumentsValue: unknown;
    try {
      argumentsValue = JSON.parse(rawArguments);
    } catch (error) {
      setToolErrors((current) => ({
        ...current,
        [key]: error instanceof Error ? error.message : "参数 JSON 无效",
      }));
      return;
    }
    if (
      !argumentsValue ||
      Array.isArray(argumentsValue) ||
      typeof argumentsValue !== "object"
    ) {
      setToolErrors((current) => ({
        ...current,
        [key]: "工具参数必须是 JSON 对象",
      }));
      return;
    }
    setBusyTool(key);
    setToolErrors((current) => ({ ...current, [key]: "" }));
    try {
      const result = await callCatalogMcpTool(
        resource,
        toolId,
        argumentsValue as Record<string, unknown>,
      );
      setToolResults((current) => ({ ...current, [key]: result }));
    } catch (error) {
      setToolErrors((current) => ({
        ...current,
        [key]: error instanceof Error ? error.message : "工具调用失败",
      }));
    } finally {
      setBusyTool(null);
    }
  }

  return (
    <div className="catalog-detail-document">
      <section>
        <h3>服务说明</h3>
        <p>{stringValue(detail.description) || "该服务暂未提供补充说明。"}</p>
      </section>
      <section>
        <h3>服务地址</h3>
        {endpoint ? (
          <dl className="catalog-contract-list">
            <div>
              <dt>Endpoint</dt>
              <dd>
                <code>{endpoint}</code>
              </dd>
            </div>
            {upstreamUrl && upstreamUrl !== endpoint ? (
              <div>
                <dt>上游地址</dt>
                <dd>
                  <code>{upstreamUrl}</code>
                </dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <p className="catalog-empty-copy">该服务暂未提供访问地址</p>
        )}
      </section>
      <section>
        <h3>工具</h3>
        <div className="catalog-tool-list">
          {tools.map((tool, index) => {
            const outputSchema = declaredMcpOutputSchema(tool);
            const key = String(tool.id ?? tool.name ?? index);
            const toolName =
              stringValue(tool.alias) ||
              stringValue(tool.name) ||
              `工具 ${index + 1}`;
            const inputValue =
              toolInputs[key] ??
              JSON.stringify(initialToolArguments(tool), null, 2);
            return (
              <details key={key} open={index === 0}>
                <summary>
                  <span>
                    <strong>{toolName}</strong>
                    <small>
                      {stringValue(tool.description) || stringValue(tool.intro)}
                    </small>
                  </span>
                  <span>查看参数</span>
                </summary>
                <div>
                  <h4>输入参数</h4>
                  <SchemaTable
                    schema={
                      tool.input_schema ??
                      objectValue(tool.invocation).input ??
                      tool.schema
                    }
                  />
                  <h4>调用响应</h4>
                  <SchemaTable schema={mcpCallResponseSchema} />
                  <h4>Tool 结果</h4>
                  {outputSchema ? (
                    <SchemaTable schema={outputSchema} />
                  ) : (
                    <>
                      <p className="catalog-schema-note">
                        该工具未声明 outputSchema，按 MCP 标准 ToolResult 展示。
                      </p>
                      <SchemaTable schema={mcpToolResultSchema} />
                    </>
                  )}
                  <div className="catalog-tool-call">
                    <label>
                      <span>调用参数（JSON）</span>
                      <textarea
                        aria-label={`调用 ${toolName} 的参数`}
                        spellCheck={false}
                        value={inputValue}
                        onChange={(event) =>
                          setToolInputs((current) => ({
                            ...current,
                            [key]: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <button
                      className="button primary compact"
                      disabled={busyTool !== null}
                      type="button"
                      onClick={() => callTool(tool, index)}
                    >
                      {busyTool === key ? (
                        <LoaderCircle className="spin" aria-hidden="true" />
                      ) : null}
                      {busyTool === key ? "调用中…" : "调用工具"}
                    </button>
                    {toolErrors[key] ? (
                      <p className="catalog-tool-call-error" role="alert">
                        {toolErrors[key]}
                      </p>
                    ) : null}
                    {toolResults[key] !== undefined ? (
                      <div className="catalog-tool-call-result">
                        <strong>实际返回</strong>
                        <pre data-mcp-call-result="">
                          <code>
                            {JSON.stringify(toolResults[key], null, 2)}
                          </code>
                        </pre>
                      </div>
                    ) : null}
                  </div>
                </div>
              </details>
            );
          })}
          {tools.length === 0 ? (
            <p className="catalog-empty-copy">暂无可展示工具</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

export function KnowledgeDetail({ detail }: { detail: CatalogResourceDetail }) {
  const documents = useMemo(
    () =>
      Array.isArray(detail.documents) ? detail.documents.map(objectValue) : [],
    [detail.documents],
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selected = documents[selectedIndex];
  const content = selected ? documentContent(selected) : "";
  return (
    <div className="catalog-knowledge-reader">
      <aside>
        <strong>文档</strong>
        <div>
          {documents.map((document, index) => (
            <button
              className={index === selectedIndex ? "active" : undefined}
              key={String(document.id ?? index)}
              type="button"
              onClick={() => setSelectedIndex(index)}
            >
              <FileText aria-hidden="true" />
              <span>{documentTitle(document, index)}</span>
            </button>
          ))}
        </div>
      </aside>
      <article className="catalog-reader-content">
        {selected ? (
          <>
            <h3>{documentTitle(selected, selectedIndex)}</h3>
            {content ? (
              renderMarkdown(content)
            ) : (
              <p className="catalog-empty-copy">该文档暂无可展示正文</p>
            )}
          </>
        ) : (
          <p className="catalog-empty-copy">知识库中暂无文档</p>
        )}
      </article>
    </div>
  );
}

export function CatalogResourceDialog({
  resource,
  onClose,
  onAddAgent,
  onInstallSkill,
  onRefresh,
}: {
  resource: CatalogResourceSummary | null;
  onClose: () => void;
  onAddAgent?: (resource: CatalogResourceSummary) => Promise<void>;
  onInstallSkill?: (resource: CatalogResourceSummary) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<CatalogResourceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    if (!resource) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setError(null);
    setDetail(null);
    setDownloaded(Boolean(resource.downloaded));
    setInstalled(false);
    readCatalogResourceDetail(resource).then(
      (value) => !cancelled && setDetail(value),
      (reason: unknown) =>
        !cancelled &&
        setError(reason instanceof Error ? reason.message : "详情加载失败"),
    );
    return () => {
      cancelled = true;
    };
  }, [resource]);

  if (!resource) return null;
  const activeResource = resource;
  const isInstallableSkill = activeResource.type === "skills";
  const isAddableAgent = activeResource.type === "agents";

  async function updateResource() {
    if (activeResource.type !== "skills") {
      setError("只有技能可以安装或更新");
      return;
    }
    setUpdating(true);
    setError(null);
    try {
      if (onInstallSkill) {
        await onInstallSkill(activeResource);
      } else {
        await downloadCatalogResource("skills", activeResource.id);
      }
      setDownloaded(true);
      setInstalled(Boolean(onInstallSkill));
      if (!onInstallSkill) {
        await onRefresh();
      }
      setDetail(await readCatalogResourceDetail(activeResource));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "资源更新失败");
    } finally {
      setUpdating(false);
    }
  }

  async function addAgent() {
    if (!onAddAgent || activeResource.type !== "agents") {
      setError("CrewON Control 或当前工作区不可用，无法加入智能体");
      return;
    }
    setUpdating(true);
    setError(null);
    try {
      await onAddAgent(activeResource);
      setInstalled(true);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "智能体加入工作区失败",
      );
    } finally {
      setUpdating(false);
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
              {resource.type === "agents"
                ? "Agent"
                : resource.type === "skills"
                  ? "技能"
                  : resource.type === "mcp_servers"
                    ? "服务"
                    : "知识库"}
            </span>
            <h2 id="catalog-resource-title">{resource.name}</h2>
            {resource.description ? <p>{resource.description}</p> : null}
          </div>
          <div>
            {isInstallableSkill ? (
              <button
                className="button compact"
                disabled={updating}
                type="button"
                onClick={updateResource}
              >
                {updating ? (
                  <LoaderCircle className="spin" aria-hidden="true" />
                ) : (
                  <RefreshCw aria-hidden="true" />
                )}
                {updating
                  ? "安装中…"
                  : installed
                    ? "重新安装技能"
                    : resource.source === "catalog" && !downloaded
                      ? "下载并安装"
                      : "安装技能"}
              </button>
            ) : null}
            {isAddableAgent ? (
              <button
                className="button compact"
                disabled={updating}
                type="button"
                onClick={addAgent}
              >
                <UserPlus aria-hidden="true" />
                {updating
                  ? "加入中…"
                  : installed
                    ? "重新加入工作区"
                    : "加入当前工作区"}
              </button>
            ) : null}
            <button
              className="icon-action compact"
              type="button"
              aria-label="关闭详情"
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </header>

        {error ? (
          <p className="catalog-resource-error" role="alert">
            {error}
          </p>
        ) : null}
        {!detail && !error ? (
          <p className="catalog-resource-loading">
            <LoaderCircle className="spin" aria-hidden="true" />
            正在读取线上资源内容…
          </p>
        ) : null}
        <div className="catalog-resource-detail-body">
          {detail && resource.type === "agents" ? (
            <AgentDetail detail={detail} />
          ) : null}
          {detail && resource.type === "skills" ? (
            <SkillDetail
              detail={detail}
              resource={{ ...resource, downloaded }}
            />
          ) : null}
          {detail && resource.type === "mcp_servers" ? (
            <McpDetail detail={detail} resource={resource} />
          ) : null}
          {detail && resource.type === "knowledge_bases" ? (
            <KnowledgeDetail detail={detail} />
          ) : null}
        </div>
        <footer className="catalog-resource-dialog-foot">
          <span>
            {isInstallableSkill ? (
              <Download aria-hidden="true" />
            ) : (
              <Eye aria-hidden="true" />
            )}
            {isInstallableSkill
              ? installed
                ? "技能已安装到当前工作区"
                : resource.source === "catalog" && downloaded
                  ? "云端已同步 · 可安装到当前工作区"
                  : resource.source === "catalog"
                    ? "目录技能 · 可下载并安装"
                    : "在线技能 · 可安装到当前工作区"
              : resource.type === "mcp_servers"
                ? "云端服务 · 可直接调用工具"
                : resource.type === "agents"
                  ? installed
                    ? "已加入当前工作区 · 可在办公室招募"
                    : "云端智能体 · 加入工作区后可在办公室招募"
                  : "在线只读 · 运行时由绑定的 Agent 使用"}
          </span>
        </footer>
      </section>
    </div>
  );
}
