import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  Download,
  FileCode2,
  FileText,
  Folder,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";

import { renderMarkdown } from "../TranscriptMarkdown";
import {
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
  const candidates = [
    tool.output_schema,
    objectValue(tool.invocation).output,
  ];
  return candidates.find((candidate) => schemaRows(candidate).length > 0) ?? null;
}

function skillMarkdown(detail: CatalogResourceDetail): string {
  if (typeof detail.skill_md === "string") return detail.skill_md;
  const skillMd = objectValue(detail.skill_md);
  return stringValue(skillMd.content);
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

export function AgentDetail({
  detail,
  resourceId,
}: {
  detail: CatalogResourceDetail;
  resourceId: number;
}) {
  const authenticated = objectValue(
    objectValue(detail.invocation).authenticated,
  );
  const input = objectValue(authenticated.input);
  const output = objectValue(authenticated.output);
  return (
    <div className="catalog-detail-document">
      <section>
        <h3>能力说明</h3>
        <p>
          {stringValue(detail.description) || "该 Agent 暂未提供补充说明。"}
        </p>
      </section>
      <section>
        <h3>访问方式</h3>
        <dl className="catalog-contract-list">
          <div>
            <dt>请求</dt>
            <dd>
              <code>
                POST /api/v1/crewon/catalog/resources/agents/{resourceId}/run
              </code>
            </dd>
          </div>
          <div>
            <dt>鉴权</dt>
            <dd>
              <code>Authorization: Bearer &lt;CrewON access token&gt;</code>
            </dd>
          </div>
          <div>
            <dt>格式</dt>
            <dd>
              <code>application/json</code>
            </dd>
          </div>
        </dl>
      </section>
      <section>
        <h3>输入参数</h3>
        <SchemaTable
          schema={{
            properties: {
              inputs: {
                type: "object",
                description: "Agent 业务输入，例如 query",
              },
              subject: { type: "object", description: "可选的调用主体信息" },
              channel: { type: "string", description: "调用来源，默认 crewon" },
            },
            required: ["inputs"],
            ...input,
          }}
        />
      </section>
      <section>
        <h3>输出结果</h3>
        <SchemaTable
          schema={{
            properties: Object.fromEntries(
              Object.entries(output).map(([name, value]) => [
                name,
                { type: displayType(value) },
              ]),
            ),
          }}
        />
      </section>
    </div>
  );
}

export function SkillDetail({
  detail,
  resourceId,
}: {
  detail: CatalogResourceDetail;
  resourceId: number;
}) {
  const [listing, setListing] = useState<CatalogSkillFile | null>(null);
  const [selectedFile, setSelectedFile] = useState<CatalogSkillFile | null>(
    null,
  );
  const [fileError, setFileError] = useState<string | null>(null);
  const markdown = markdownBody(skillMarkdown(detail));

  useEffect(() => {
    let cancelled = false;
    readCatalogSkillFile(resourceId).then(
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
  }, [resourceId]);

  async function openPath(path: string, type: "directory" | "file") {
    setFileError(null);
    try {
      const value = await readCatalogSkillFile(resourceId, path);
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
          <p className="catalog-empty-copy">暂无 Skill 文档</p>
        )}
      </article>
    </div>
  );
}

export function McpDetail({ detail }: { detail: CatalogResourceDetail }) {
  const tools = Array.isArray(detail.tools)
    ? detail.tools.map(objectValue)
    : [];
  const endpoint =
    stringValue(detail.endpoint) ||
    stringValue(detail.url) ||
    stringValue(objectValue(detail.invocation).url);
  const upstreamUrl = stringValue(detail.url);
  return (
    <div className="catalog-detail-document">
      <section>
        <h3>服务说明</h3>
        <p>
          {stringValue(detail.description) || "该 MCP 服务暂未提供补充说明。"}
        </p>
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
          <p className="catalog-empty-copy">该 MCP 服务暂未提供访问地址</p>
        )}
      </section>
      <section>
        <h3>工具</h3>
        <div className="catalog-tool-list">
          {tools.map((tool, index) => {
            const outputSchema = declaredMcpOutputSchema(tool);
            return (
              <details
                key={String(tool.id ?? tool.name ?? index)}
                open={index === 0}
              >
                <summary>
                  <span>
                    <strong>
                      {stringValue(tool.alias) ||
                        stringValue(tool.name) ||
                        `工具 ${index + 1}`}
                    </strong>
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
  onRefresh,
}: {
  resource: CatalogResourceSummary | null;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<CatalogResourceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    if (!resource) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setError(null);
    setDetail(null);
    readCatalogResourceDetail(resource.type, resource.id).then(
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

  async function updateResource() {
    setUpdating(true);
    setError(null);
    try {
      await downloadCatalogResource(activeResource.type, activeResource.id);
      await onRefresh();
      setDetail(
        await readCatalogResourceDetail(activeResource.type, activeResource.id),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "资源更新失败");
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
                  ? "Skill"
                  : resource.type === "mcp_servers"
                    ? "MCP"
                    : "知识库"}
            </span>
            <h2 id="catalog-resource-title">{resource.name}</h2>
            {resource.description ? <p>{resource.description}</p> : null}
          </div>
          <div>
            {resource.update_available ? (
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
                更新资源
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
            正在读取已下载内容…
          </p>
        ) : null}
        <div className="catalog-resource-detail-body">
          {detail && resource.type === "agents" ? (
            <AgentDetail detail={detail} resourceId={resource.id} />
          ) : null}
          {detail && resource.type === "skills" ? (
            <SkillDetail detail={detail} resourceId={resource.id} />
          ) : null}
          {detail && resource.type === "mcp_servers" ? (
            <McpDetail detail={detail} />
          ) : null}
          {detail && resource.type === "knowledge_bases" ? (
            <KnowledgeDetail detail={detail} />
          ) : null}
        </div>
        <footer className="catalog-resource-dialog-foot">
          <span>
            <Download aria-hidden="true" />
            已保存到当前账号资源池
          </span>
        </footer>
      </section>
    </div>
  );
}
