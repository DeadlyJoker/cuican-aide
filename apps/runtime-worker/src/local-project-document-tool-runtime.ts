import { LocalProjectDocuments } from "@crewon/store/local-project-documents";
import {
  InMemoryToolBroker,
  ToolBrokerError,
  type ToolDefinition,
  type ToolExecutionPolicy,
  type ToolRuntimePort,
} from "@crewon/tool-broker";
import { isDeepStrictEqual } from "node:util";
import { DesktopThreadWorkspaceToolRuntime } from "./desktop-thread-workspace-runtime.ts";

/** Composed inside the existing immutable Thread workspace router. No input may choose a root. */
export const LOCAL_PROJECT_DOCUMENT_TOOLS: readonly ToolDefinition[] = [
  {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name: "project_document_read",
    description:
      "Read a bounded portion of a local project document shared with the project panel. Use documentId brief, script, bible, shots, assets, generation, qc or release. Returns revision for conflict-safe saves. Existing database documents remain in the legacy project view.",
    execution: "parallel",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        documentId: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,79}$" },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["documentId"],
    },
  },
  {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name: "project_document_save",
    description:
      "Save a local project document shared with the project panel, retaining all previous revisions. Read first and pass its expectedRevision (0 for a new file). On revision conflict read again and reconcile. Use this direct operation for local text, without shell commands or database duplication.",
    execution: "serial",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        documentId: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,79}$" },
        expectedRevision: { type: "integer", minimum: 0 },
        content: { type: "string", maxLength: 65536 },
      },
      required: ["documentId", "expectedRevision", "content"],
    },
  },
];

export function createLocalProjectDocumentToolRuntime(
  root: string,
): ToolRuntimePort {
  return documentRuntime(new LocalProjectDocuments(root));
}

export function createDeclaredLocalProjectDocumentRuntime(
  environment: Readonly<Record<string, string | undefined>>,
  definitions: readonly ToolDefinition[],
): ToolRuntimePort | undefined {
  const declared = definitions.filter((tool) =>
    LOCAL_PROJECT_DOCUMENT_TOOLS.some(
      (expected) => expected.name === tool.name,
    ),
  );
  if (declared.length === 0) return undefined;
  if (!isDeepStrictEqual(declared, LOCAL_PROJECT_DOCUMENT_TOOLS))
    throw new Error("project_document_catalog_mismatch");
  const registryPath = environment.CREWON_DESKTOP_WORKSPACE_REGISTRY_PATH;
  const databasePath = environment.CREWON_CONTROL_DB_PATH;
  const tenantId = environment.CREWON_TENANT_ID;
  const spaceId = environment.CREWON_SPACE_ID;
  if (
    environment.CREWON_CONTROL_SECURITY_MODE !== "standalone" ||
    !registryPath ||
    !databasePath ||
    !tenantId ||
    !spaceId
  )
    throw new Error("project_document_native_workspace_required");
  return new DesktopThreadWorkspaceToolRuntime(documentRuntime(null), {
    registryPath,
    databasePath,
    tenantId,
    spaceId,
    createRuntime: async (root) => createLocalProjectDocumentToolRuntime(root),
  });
}

function documentRuntime(store: LocalProjectDocuments | null): ToolRuntimePort {
  const policy: ToolExecutionPolicy = {
    effect: "readOnly",
    recovery: "replaySafe",
    resourceBindingId: "local-workspace",
    credentialBindingId: null,
    executionTarget: { kind: "control", bindingId: "local-workspace" },
    capability: "workspace.read.v0",
    approvalRequirement: "none",
    limits: { timeoutMs: 5000, maxOutputBytes: 32768, maxArtifactBytes: 1 },
  };
  return new InMemoryToolBroker(
    LOCAL_PROJECT_DOCUMENT_TOOLS,
    new Map([
      [
        "function:project_document_read",
        async (invocation) => {
          const value = parse(invocation.input, ["documentId", "offset"]);
          const offset = value.offset ?? 0;
          if (!Number.isSafeInteger(offset) || Number(offset) < 0)
            throw new ToolBrokerError("project_document_offset_invalid");
          if (!store)
            throw new ToolBrokerError("project_document_workspace_unbound");
          const document = store.read(String(value.documentId));
          const end = Number(offset) + 6000;
          return {
            output: JSON.stringify(
              document === null
                ? { document: null }
                : {
                    ...document,
                    content: document.content.slice(Number(offset), end),
                    nextOffset: end < document.content.length ? end : null,
                  },
            ),
          };
        },
      ],
      [
        "function:project_document_save",
        async (invocation) => {
          const value = parse(invocation.input, [
            "documentId",
            "expectedRevision",
            "content",
          ]);
          if (
            typeof value.documentId !== "string" ||
            typeof value.content !== "string" ||
            value.content.length > 65536 ||
            typeof value.expectedRevision !== "number"
          )
            throw new ToolBrokerError("project_document_input_invalid");
          let saved;
          try {
            if (!store) throw new Error("project_document_workspace_unbound");
            saved = store.save({
              documentId: value.documentId,
              content: value.content,
              expectedRevision: value.expectedRevision,
            });
          } catch (error) {
            const code =
              error instanceof Error &&
              /^project_document_[a-z_]+$/.test(error.message)
                ? error.message
                : "project_document_unavailable";
            return { isError: true, output: JSON.stringify({ error: code }) };
          }
          return {
            output: JSON.stringify({
              documentId: saved.documentId,
              revision: saved.revision,
              digest: saved.digest,
            }),
          };
        },
      ],
    ]),
    new Map([
      ["function:project_document_read", policy],
      [
        "function:project_document_save",
        {
          ...policy,
          effect: "mutation",
          recovery: "reconcilable",
          capability: "workspace.command.v0",
          approvalRequirement: "perAction",
        },
      ],
    ]),
  );
}

function parse(
  input: string,
  keys: readonly string[],
): Record<string, unknown> {
  const value: unknown = JSON.parse(input);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new ToolBrokerError("project_document_input_invalid");
  return value as Record<string, unknown>;
}
