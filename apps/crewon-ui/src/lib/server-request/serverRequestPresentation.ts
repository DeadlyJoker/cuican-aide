import type { AppServerRequest } from "../app-server/appServer";
import type {
  CapabilityPanel,
  CapabilityPanelField,
} from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";

export type UserInputQuestion = {
  id: string;
  label: string;
  placeholder?: string;
  secret: boolean;
};

export type ToolRequestDetails = {
  title: string;
  body: string;
};

export type McpElicitationDetails = {
  title: string;
  body: string;
  placeholder: string;
};

export type ServerRequestPendingState =
  | {
      type: "approval";
      id: number | string;
      method: string;
      params?: unknown;
    }
  | {
      type: "userInput";
      id: number | string;
      questionIds: string[];
    }
  | {
      type: "dynamicTool";
      id: number | string;
      fieldId: string;
    }
  | {
      type: "mcpElicitation";
      id: number | string;
      fieldId: string;
    }
  | {
      type: "externalSecret";
      id: number | string;
      kind: "chatgptAuthTokens" | "attestation";
    }
  | null;

export type ServerRequestPresentation = {
  panel: CapabilityPanel;
  pending: ServerRequestPendingState;
};

export type ExternalSecretResolution =
  | { type: "reject"; reason: string }
  | {
      type: "respond";
      payload:
        | {
            accessToken: string;
            chatgptAccountId: string;
            chatgptPlanType: string | null;
          }
        | { token: string };
    };

export function buildExternalSecretResolution(
  actionId: string,
  kind: "chatgptAuthTokens" | "attestation",
  fieldValue: (fieldId: string) => string,
): ExternalSecretResolution {
  if (actionId === "reject-external-secret") {
    return {
      type: "reject",
      reason:
        kind === "attestation"
          ? "Attestation token was not provided"
          : "Model account auth tokens were not provided",
    };
  }

  if (kind === "chatgptAuthTokens") {
    const accessToken = fieldValue("accessToken");
    const chatgptAccountId = fieldValue("chatgptAccountId");
    if (!accessToken || !chatgptAccountId) {
      return {
        type: "reject",
        reason: "Missing model account access token or account id",
      };
    }
    return {
      type: "respond",
      payload: {
        accessToken,
        chatgptAccountId,
        chatgptPlanType: fieldValue("chatgptPlanType") || null,
      },
    };
  }

  const token = fieldValue("attestationToken");
  return token
    ? { type: "respond", payload: { token } }
    : { type: "reject", reason: "Missing attestation token" };
}

export function externalSecretHandledBody(
  wasExplicitReject: boolean,
  locale: Locale,
): string {
  return wasExplicitReject
    ? locale === "zh"
      ? "已拒绝请求"
      : "Request rejected"
    : locale === "zh"
      ? "已提交响应"
      : "Response submitted";
}

export function buildMcpElicitationResponse(actionId: string, value: string): {
  action: "accept" | "decline" | "cancel";
  content: unknown;
  _meta: null;
} {
  const action =
    actionId === "accept-mcp-elicitation"
      ? "accept"
      : actionId === "decline-mcp-elicitation"
        ? "decline"
        : "cancel";
  let content: unknown = null;

  if (action === "accept" && value) {
    try {
      content = JSON.parse(value);
    } catch {
      content = value;
    }
  }

  return {
    action,
    content: action === "accept" ? content : null,
    _meta: null,
  };
}

export function mcpElicitationHandledBody(
  action: "accept" | "decline" | "cancel",
  locale: Locale,
): string {
  return action === "accept"
    ? locale === "zh"
      ? "已提交 MCP 输入"
      : "MCP input submitted"
    : locale === "zh"
      ? "已结束 MCP 输入请求"
      : "MCP elicitation closed";
}

export function buildDynamicToolResponse(
  actionId: string,
  value: string,
  locale: Locale,
): { contentItems: Array<{ type: "inputText"; text: string }>; success: boolean } {
  const success = actionId === "complete-dynamic-tool";
  const text =
    value ||
    (success
      ? locale === "zh"
        ? "工具调用已完成。"
        : "Tool call completed."
      : locale === "zh"
        ? "工具调用被用户标记为失败。"
        : "Tool call marked as failed by the user.");

  return {
    contentItems: [{ type: "inputText", text }],
    success,
  };
}

export function dynamicToolHandledBody(success: boolean, locale: Locale): string {
  return success
    ? locale === "zh"
      ? "已返回工具结果"
      : "Tool result returned"
    : locale === "zh"
      ? "已返回工具失败"
      : "Tool failure returned";
}

export function buildUserInputAnswers(
  fields: CapabilityPanelField[] | undefined,
  questionIds: string[],
  shouldSubmit: boolean,
): Record<string, { answers: string[] }> {
  return shouldSubmit
    ? Object.fromEntries(
        (fields ?? [])
          .filter((field) => questionIds.includes(field.id))
          .map((field) => [
            field.id,
            { answers: field.value.trim() ? [field.value.trim()] : [] },
          ]),
      )
    : {};
}

export function userInputHandledBody(
  shouldSubmit: boolean,
  locale: Locale,
): string {
  return shouldSubmit
    ? locale === "zh"
      ? "已提交输入"
      : "Input submitted"
    : locale === "zh"
      ? "已取消输入请求"
      : "Input request cancelled";
}

export function buildApprovalResponse(
  method: string,
  isApprove: boolean,
  params: unknown,
): Record<string, unknown> {
  if (method === "item/permissions/requestApproval") {
    return {
      permissions: isApprove ? grantedPermissionsFromRequest(params) : {},
      scope: "turn",
      strictAutoReview: isApprove ? undefined : true,
    };
  }

  if (method === "applyPatchApproval" || method === "execCommandApproval") {
    return { decision: isApprove ? "approved" : "denied" };
  }

  return { decision: isApprove ? "accept" : "decline" };
}

export function approvalHandledBody(isApprove: boolean, locale: Locale): string {
  return isApprove
    ? locale === "zh"
      ? "已同意请求"
      : "Request approved"
    : locale === "zh"
      ? "已拒绝请求"
      : "Request declined";
}

export function buildServerRequestPresentation(
  request: AppServerRequest,
  locale: Locale,
): ServerRequestPresentation {
  const label = serverRequestLabel(request.method, locale);
  const details = serverRequestDetails(request.params);
  const isInteractiveApproval =
    request.method === "item/commandExecution/requestApproval" ||
    request.method === "item/fileChange/requestApproval" ||
    request.method === "item/permissions/requestApproval" ||
    request.method === "applyPatchApproval" ||
    request.method === "execCommandApproval";

  if (isInteractiveApproval) {
    return {
      pending: {
        type: "approval",
        id: request.id,
        method: request.method,
        params: request.params,
      },
      panel: {
        title: label,
        subtitle: String(request.id),
        actions: [
          {
            id: "approve-request",
            label: locale === "zh" ? "同意" : "Approve",
            tone: "primary",
          },
          {
            id: "decline-request",
            label: locale === "zh" ? "拒绝" : "Decline",
            tone: "danger",
          },
        ],
        body: details || (locale === "zh" ? "等待处理" : "Waiting for review"),
      },
    };
  }

  if (request.method === "item/tool/requestUserInput") {
    const questions = getUserInputQuestions(request.params);
    return {
      pending: {
        type: "userInput",
        id: request.id,
        questionIds: questions.map((question) => question.id),
      },
      panel: {
        title: label,
        subtitle: String(request.id),
        body:
          details ||
          (locale === "zh"
            ? "请补充后端请求的信息"
            : "Answer the backend request"),
        fields: questions.map((question) => ({
          id: question.id,
          label: question.label,
          placeholder: question.placeholder,
          secret: question.secret,
          value: "",
        })),
        actions: [
          {
            id: "submit-user-input",
            label: locale === "zh" ? "提交" : "Submit",
            tone: "primary",
          },
          {
            id: "cancel-user-input",
            label: locale === "zh" ? "取消" : "Cancel",
          },
        ],
      },
    };
  }

  if (request.method === "item/tool/call") {
    const tool = getDynamicToolDetails(request.params);
    const fieldId = "dynamic-tool-result";
    return {
      pending: { type: "dynamicTool", id: request.id, fieldId },
      panel: {
        title: `${label}: ${tool.title}`,
        subtitle: String(request.id),
        body: tool.body || tool.title,
        fields: [
          {
            id: fieldId,
            label:
              locale === "zh"
                ? "返回给工具调用的文本"
                : "Text returned to the tool call",
            placeholder:
              locale === "zh"
                ? "输入工具结果..."
                : "Enter tool result...",
            value: "",
          },
        ],
        actions: [
          {
            id: "complete-dynamic-tool",
            label: locale === "zh" ? "返回成功" : "Return success",
            tone: "primary",
          },
          {
            id: "fail-dynamic-tool",
            label: locale === "zh" ? "返回失败" : "Return failure",
            tone: "danger",
          },
        ],
      },
    };
  }

  if (request.method === "mcpServer/elicitation/request") {
    const elicitation = getMcpElicitationDetails(request.params);
    const fieldId = "mcp-elicitation-content";
    return {
      pending: { type: "mcpElicitation", id: request.id, fieldId },
      panel: {
        title: `${label}: ${elicitation.title}`,
        subtitle: String(request.id),
        body:
          elicitation.body ||
          (locale === "zh"
            ? "MCP 服务器请求输入"
            : "MCP server requested input"),
        fields: [
          {
            id: fieldId,
            label: locale === "zh" ? "返回内容 JSON" : "Response content JSON",
            placeholder: elicitation.placeholder,
            value: "",
          },
        ],
        actions: [
          {
            id: "accept-mcp-elicitation",
            label: locale === "zh" ? "接受" : "Accept",
            tone: "primary",
          },
          {
            id: "decline-mcp-elicitation",
            label: locale === "zh" ? "拒绝" : "Decline",
            tone: "danger",
          },
          {
            id: "cancel-mcp-elicitation",
            label: locale === "zh" ? "取消" : "Cancel",
          },
        ],
      },
    };
  }

  if (request.method === "account/chatgptAuthTokens/refresh") {
    return {
      pending: {
        type: "externalSecret",
        id: request.id,
        kind: "chatgptAuthTokens",
      },
      panel: {
        title: label,
        subtitle: String(request.id),
        body: [
          getParamDisplay(request.params, "reason"),
          getParamDisplay(request.params, "previousAccountId"),
        ]
          .filter(Boolean)
          .join("\n"),
        fields: [
          {
            id: "accessToken",
            label: locale === "zh" ? "Access Token" : "Access token",
            secret: true,
            value: "",
          },
          {
            id: "chatgptAccountId",
            label: locale === "zh" ? "账号 ID" : "Account ID",
            value: "",
          },
          {
            id: "chatgptPlanType",
            label: locale === "zh" ? "计划类型" : "Plan type",
            placeholder: "pro",
            value: "",
          },
        ],
        actions: [
          {
            id: "submit-auth-refresh",
            label: locale === "zh" ? "提交 Token" : "Submit token",
            tone: "primary",
          },
          {
            id: "reject-external-secret",
            label: locale === "zh" ? "拒绝" : "Reject",
            tone: "danger",
          },
        ],
      },
    };
  }

  if (request.method === "attestation/generate") {
    return {
      pending: {
        type: "externalSecret",
        id: request.id,
        kind: "attestation",
      },
      panel: {
        title: label,
        subtitle: String(request.id),
        body:
          locale === "zh"
            ? "输入外部 attestation token。"
            : "Enter an external attestation token.",
        fields: [
          { id: "attestationToken", label: "Token", secret: true, value: "" },
        ],
        actions: [
          {
            id: "submit-attestation",
            label: locale === "zh" ? "提交 Token" : "Submit token",
            tone: "primary",
          },
          {
            id: "reject-external-secret",
            label: locale === "zh" ? "拒绝" : "Reject",
            tone: "danger",
          },
        ],
      },
    };
  }

  return {
    pending: null,
    panel: {
      title: locale === "zh" ? "后端请求" : "Server request",
      subtitle: String(request.id),
      body:
        locale === "zh"
          ? `${label}\n已发送保守响应，避免当前任务悬挂。`
          : `${label}\nSent a conservative response so the turn does not hang.`,
    },
  };
}

function serverRequestDetails(params: unknown): string {
  return [
    getParamDisplay(params, "command"),
    getParamDisplay(params, "cwd"),
    getParamDisplay(params, "reason"),
    getParamDisplay(params, "grantRoot"),
    getParamDisplay(params, "permissions"),
    getParamDisplay(params, "fileChanges"),
  ]
    .filter(Boolean)
    .join("\n");
}

function serverRequestLabel(method: string, locale: Locale): string {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "execCommandApproval":
      return locale === "zh" ? "命令审批" : "Command approval";
    case "item/fileChange/requestApproval":
      return locale === "zh" ? "文件变更审批" : "File change approval";
    case "item/permissions/requestApproval":
      return locale === "zh" ? "权限请求" : "Permission request";
    case "item/tool/requestUserInput":
      return locale === "zh" ? "用户输入请求" : "User input request";
    case "item/tool/call":
      return locale === "zh" ? "动态工具调用" : "Dynamic tool call";
    case "applyPatchApproval":
      return locale === "zh" ? "补丁审批" : "Patch approval";
    case "mcpServer/elicitation/request":
      return locale === "zh" ? "MCP 输入请求" : "MCP elicitation";
    case "account/chatgptAuthTokens/refresh":
      return locale === "zh" ? "刷新模型账号 Token" : "Refresh model account token";
    case "attestation/generate":
      return locale === "zh" ? "Attestation Token" : "Attestation token";
    default:
      return method;
  }
}

export function getParamDisplay(params: unknown, key: string): string | null {
  if (!params || typeof params !== "object" || !(key in params)) {
    return null;
  }

  const value = (params as Record<string, unknown>)[key];
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  if (Array.isArray(value) && value.length > 0) {
    return value.map((entry) => String(entry)).join(" ");
  }

  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  return null;
}

export function grantedPermissionsFromRequest(
  params: unknown,
): Record<string, unknown> {
  if (!params || typeof params !== "object" || !("permissions" in params)) {
    return {};
  }

  const requested = (params as { permissions?: unknown }).permissions;
  if (!requested || typeof requested !== "object") {
    return {};
  }

  const record = requested as Record<string, unknown>;
  return Object.fromEntries(
    ["network", "fileSystem"].flatMap((key) => {
      const value = record[key];
      return value && typeof value === "object" ? [[key, value]] : [];
    }),
  );
}

export function getUserInputQuestions(params: unknown): UserInputQuestion[] {
  if (!params || typeof params !== "object" || !("questions" in params)) {
    return [];
  }

  const questions = (params as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) {
    return [];
  }

  return questions.flatMap((question) => {
    if (!question || typeof question !== "object") {
      return [];
    }

    const record = question as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;
    if (!id) {
      return [];
    }

    const header = typeof record.header === "string" ? record.header : "";
    const prompt = typeof record.question === "string" ? record.question : "";
    const options = Array.isArray(record.options)
      ? record.options
          .flatMap((option) =>
            option &&
            typeof option === "object" &&
            typeof (option as Record<string, unknown>).label === "string"
              ? [(option as Record<string, string>).label]
              : [],
          )
          .join(" / ")
      : "";
    const label = [header, prompt].filter(Boolean).join(" - ") || id;
    return [
      {
        id,
        label,
        placeholder: options || undefined,
        secret: record.isSecret === true,
      },
    ];
  });
}

export function getDynamicToolDetails(params: unknown): ToolRequestDetails {
  if (!params || typeof params !== "object") {
    return { title: "tool", body: "" };
  }

  const record = params as Record<string, unknown>;
  const namespace =
    typeof record.namespace === "string" && record.namespace
      ? `${record.namespace}.`
      : "";
  const tool =
    typeof record.tool === "string" && record.tool ? record.tool : "tool";
  const callId = typeof record.callId === "string" ? record.callId : "";
  const threadId = typeof record.threadId === "string" ? record.threadId : "";
  const turnId = typeof record.turnId === "string" ? record.turnId : "";
  const args = "arguments" in record ? record.arguments : null;
  const argsText =
    args === null || args === undefined
      ? ""
      : (() => {
          try {
            return JSON.stringify(args, null, 2);
          } catch {
            return String(args);
          }
        })();

  return {
    title: `${namespace}${tool}`,
    body: [
      callId ? `callId: ${callId}` : null,
      threadId ? `threadId: ${threadId}` : null,
      turnId ? `turnId: ${turnId}` : null,
      argsText ? `arguments:\n${argsText}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function getMcpElicitationDetails(
  params: unknown,
): McpElicitationDetails {
  if (!params || typeof params !== "object") {
    return { title: "MCP", body: "", placeholder: "{}" };
  }

  const record = params as Record<string, unknown>;
  const serverName =
    typeof record.serverName === "string" ? record.serverName : "MCP";
  const mode = typeof record.mode === "string" ? record.mode : "request";
  const message = typeof record.message === "string" ? record.message : "";
  const url = typeof record.url === "string" ? record.url : "";
  const requestedSchema =
    "requestedSchema" in record ? record.requestedSchema : null;
  const schemaText =
    requestedSchema === null || requestedSchema === undefined
      ? ""
      : (() => {
          try {
            return JSON.stringify(requestedSchema, null, 2);
          } catch {
            return String(requestedSchema);
          }
        })();

  return {
    title: `${serverName} · ${mode}`,
    body: [
      message,
      url ? `url: ${url}` : null,
      schemaText ? `schema:\n${schemaText}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    placeholder: mode === "form" ? "{}" : "",
  };
}

export function decodeBase64Text(dataBase64: string): string {
  const bytes = Uint8Array.from(window.atob(dataBase64), (character) =>
    character.charCodeAt(0),
  );
  return new TextDecoder().decode(bytes);
}

export function encodeCapabilityActionPayload(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value));
}

export function decodeCapabilityActionPayload<T>(value: string): T | null {
  try {
    return JSON.parse(decodeURIComponent(value)) as T;
  } catch {
    return null;
  }
}
