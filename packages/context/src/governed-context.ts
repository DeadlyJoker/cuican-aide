import type { ContextHistoryItem } from "./normalize-context-history.ts";

const MAX_FRAGMENT_TOKENS = 10_000;
const MAX_FRAGMENTS = 64;
const MAX_BUNDLE_BYTES = 512 * 1024;
// One model token cannot encode more source bytes than this conservative bound.
// Provider-specific tokenizers may be more efficient, but hard caps must not depend on that.
const BYTES_PER_TOKEN_ESTIMATE = 1;

export type GovernedContextAudience = Readonly<{
  bindingId: string;
  scopeKind: "single" | "experts" | "officeShared";
  scopeId: string;
}>;

export type GovernedContextFragmentSpec = Readonly<{
  fragmentId: string;
  audience: GovernedContextAudience;
  provenance: Readonly<{
    sourceKind:
      | "application"
      | "provider"
      | "user"
      | "memory"
      | "resource"
      | "tool"
      | "web";
    sourceId: string;
    actorId: string;
  }>;
  trust: "trustedApplication" | "untrustedData";
  sensitivity: "public" | "workspaceSensitive" | "secret";
  purpose: "taskInput" | "reference" | "memory" | "toolResult";
  budget: Readonly<{ tokenCap: number }>;
  freshness: Readonly<{
    observedAt: string;
    expiresAt: string | null;
  }>;
  content: string;
}>;

export interface GovernedContextDigester {
  sha256(value: string): string;
}

/** A validated, immutable model prefix with explicit trust-channel roles. */
export class GovernedContextBundle {
  readonly audience: GovernedContextAudience;
  readonly byteLength: number;
  readonly #items: readonly ContextHistoryItem[];

  private constructor(
    audience: GovernedContextAudience,
    items: readonly ContextHistoryItem[],
    byteLength: number,
  ) {
    this.audience = structuredClone(audience);
    this.#items = structuredClone(items);
    this.byteLength = byteLength;
  }

  static build(
    input: Readonly<{
      audience: GovernedContextAudience;
      fragments: readonly GovernedContextFragmentSpec[];
      digester: GovernedContextDigester;
    }>,
  ): GovernedContextBundle {
    validateAudience(input.audience);
    if (
      !Array.isArray(input.fragments) ||
      input.fragments.length < 1 ||
      input.fragments.length > MAX_FRAGMENTS
    ) {
      throw new GovernedContextError("governed_context_fragment_count_invalid");
    }
    const fragmentIds = new Set<string>();
    const items: ContextHistoryItem[] = [];
    let bundleBytes = 0;
    for (const spec of input.fragments) {
      validateFragmentSpec(spec, input.audience, fragmentIds);
      const originalTokens = estimateTokens(spec.content);
      const projection = projectEscapedContent(
        spec.content,
        spec.budget.tokenCap * BYTES_PER_TOKEN_ESTIMATE,
      );
      const projectedContent = projection.content;
      const projectedTokens = estimateTokens(projectedContent);
      const metadata = {
        schemaVersion: "crewon.governed-context-fragment.v0",
        fragmentId: spec.fragmentId,
        audience: spec.audience,
        provenance: spec.provenance,
        trust: spec.trust,
        sensitivity: spec.sensitivity,
        purpose: spec.purpose,
        budget: spec.budget,
        freshness: spec.freshness,
        estimatedTokens: projectedTokens,
        contentDigest: requireDigest(
          input.digester.sha256(projectedContent),
          "governed_context_digest_invalid",
        ),
        sourceDigest: requireDigest(
          input.digester.sha256(spec.content),
          "governed_context_source_digest_invalid",
        ),
        truncatedFromTokens:
          projectedContent === spec.content ? null : originalTokens,
      } as const;
      const content = [
        "<crewon_governed_context>",
        JSON.stringify(metadata),
        "<content>",
        projection.escaped,
        "</content>",
        "</crewon_governed_context>",
      ].join("\n");
      bundleBytes += byteLength(content);
      if (bundleBytes > MAX_BUNDLE_BYTES) {
        throw new GovernedContextError("governed_context_bundle_too_large");
      }
      items.push({
        type: "message",
        role: spec.trust === "trustedApplication" ? "developer" : "user",
        content,
      });
    }
    return new GovernedContextBundle(input.audience, items, bundleBytes);
  }

  modelItems(): readonly ContextHistoryItem[] {
    return structuredClone(this.#items);
  }
}

export class GovernedContextError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "GovernedContextError";
    this.code = code;
  }
}

function validateFragmentSpec(
  spec: GovernedContextFragmentSpec,
  audience: GovernedContextAudience,
  fragmentIds: Set<string>,
): void {
  requireBounded(spec.fragmentId, 256, "governed_context_fragment_id_invalid");
  if (fragmentIds.has(spec.fragmentId)) {
    throw new GovernedContextError("governed_context_fragment_duplicate");
  }
  fragmentIds.add(spec.fragmentId);
  validateAudience(spec.audience);
  if (JSON.stringify(spec.audience) !== JSON.stringify(audience)) {
    throw new GovernedContextError("governed_context_audience_mismatch");
  }
  requireBounded(
    spec.provenance.sourceId,
    512,
    "governed_context_source_id_invalid",
  );
  requireBounded(
    spec.provenance.actorId,
    256,
    "governed_context_actor_id_invalid",
  );
  if (
    ![
      "application",
      "provider",
      "user",
      "memory",
      "resource",
      "tool",
      "web",
    ].includes(spec.provenance.sourceKind)
  ) {
    throw new GovernedContextError("governed_context_source_kind_invalid");
  }
  if (spec.trust !== "trustedApplication" && spec.trust !== "untrustedData") {
    throw new GovernedContextError("governed_context_trust_invalid");
  }
  if (
    spec.trust === "trustedApplication" &&
    spec.provenance.sourceKind !== "application"
  ) {
    throw new GovernedContextError("governed_context_trust_source_invalid");
  }
  if (spec.sensitivity === "secret") {
    throw new GovernedContextError("governed_context_secret_not_model_visible");
  }
  if (
    spec.sensitivity !== "public" &&
    spec.sensitivity !== "workspaceSensitive"
  ) {
    throw new GovernedContextError("governed_context_sensitivity_invalid");
  }
  if (
    !["taskInput", "reference", "memory", "toolResult"].includes(spec.purpose)
  ) {
    throw new GovernedContextError("governed_context_purpose_invalid");
  }
  if (
    !Number.isSafeInteger(spec.budget.tokenCap) ||
    spec.budget.tokenCap < 1 ||
    spec.budget.tokenCap > MAX_FRAGMENT_TOKENS
  ) {
    throw new GovernedContextError("governed_context_token_cap_invalid");
  }
  requireTimestamp(
    spec.freshness.observedAt,
    "governed_context_observed_at_invalid",
  );
  if (spec.freshness.expiresAt !== null) {
    requireTimestamp(
      spec.freshness.expiresAt,
      "governed_context_expires_at_invalid",
    );
    if (
      Date.parse(spec.freshness.expiresAt) <=
      Date.parse(spec.freshness.observedAt)
    ) {
      throw new GovernedContextError("governed_context_freshness_invalid");
    }
  }
  requireBounded(
    spec.content,
    MAX_FRAGMENT_TOKENS * 16,
    "governed_context_content_invalid",
  );
}

function validateAudience(audience: GovernedContextAudience): void {
  requireBounded(
    audience.bindingId,
    512,
    "governed_context_binding_id_invalid",
  );
  requireBounded(audience.scopeId, 512, "governed_context_scope_id_invalid");
  if (
    audience.scopeKind !== "single" &&
    audience.scopeKind !== "experts" &&
    audience.scopeKind !== "officeShared"
  ) {
    throw new GovernedContextError("governed_context_scope_kind_invalid");
  }
}

function projectEscapedContent(
  value: string,
  maxBytes: number,
): Readonly<{ content: string; escaped: string }> {
  let bytes = 0;
  let content = "";
  let escaped = "";
  for (const character of value) {
    const projected = escapeContextXmlText(character);
    const characterBytes = byteLength(projected);
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    bytes += characterBytes;
    content += character;
    escaped += projected;
  }
  return { content, escaped };
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(byteLength(value) / BYTES_PER_TOKEN_ESTIMATE));
}

/** Escapes untrusted text before placing it inside a model-visible XML envelope. */
export function escapeContextXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function requireTimestamp(value: string, code: string): void {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new GovernedContextError(code);
  }
}

function requireBounded(value: string, maxBytes: number, code: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    byteLength(value) > maxBytes
  ) {
    throw new GovernedContextError(code);
  }
}

function requireDigest(value: string, code: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new GovernedContextError(code);
  }
  return value;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
