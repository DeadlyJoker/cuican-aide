import { createHash, timingSafeEqual } from "node:crypto";

import {
  AgentVersionError,
  parseAgentVersionAsset,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import {
  AgentVersionApplicationService,
  ApplicationError,
  type ActorContext,
  type ApplicationClock,
  type ApplicationIdGenerator,
  type ApplicationIdKind,
  type AuthorizationDecision,
  type AuthorizationPort,
  type ContentDigester,
  type AgentVersionStore,
  type AgentVersionReleaseStore,
  type RunRoute,
  type RunStore,
} from "@crewon/application";
import { v7 as uuidv7 } from "uuid";

import {
  ControlApiIdentityError,
  type AgentVersionAdmissionPort,
  type ControlApiIdentityPort,
  type ControlApiReadinessPort,
  type ControlApiRequestContext,
  type RunRouteResolverPort,
} from "./control-api-ports.ts";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export class StandaloneIdentity implements ControlApiIdentityPort {
  readonly #actor: ActorContext;
  readonly #sessionToken: string;
  readonly #csrfToken: string;
  readonly #allowedOrigins: ReadonlySet<string>;

  constructor(config: {
    actor: ActorContext;
    sessionToken: string;
    csrfToken: string;
    allowedOrigins: readonly string[];
  }) {
    requireSecret(config.sessionToken, "session_token_invalid");
    requireSecret(config.csrfToken, "csrf_token_invalid");
    if (config.allowedOrigins.length === 0) {
      throw new Error("allowed_origins_empty");
    }
    this.#actor = structuredClone(config.actor);
    this.#sessionToken = config.sessionToken;
    this.#csrfToken = config.csrfToken;
    this.#allowedOrigins = new Set(config.allowedOrigins);
  }

  async resolveActor(request: ControlApiRequestContext): Promise<ActorContext> {
    if (!LOOPBACK_ADDRESSES.has(request.remoteAddress)) {
      throw new ControlApiIdentityError(
        "authorization",
        "standalone_loopback_required",
      );
    }
    const authorization = singleHeader(request.headers.authorization);
    if (
      authorization === null ||
      !authorization.startsWith("Bearer ") ||
      !safeEqual(authorization.slice("Bearer ".length), this.#sessionToken)
    ) {
      throw new ControlApiIdentityError("authentication", "session_invalid");
    }
    const origin = singleHeader(request.headers.origin);
    if (origin === null || !this.#allowedOrigins.has(origin)) {
      throw new ControlApiIdentityError("authorization", "origin_not_allowed");
    }
    if (isMutation(request.method)) {
      const csrf = singleHeader(request.headers["x-csrf-token"]);
      if (csrf === null || !safeEqual(csrf, this.#csrfToken)) {
        throw new ControlApiIdentityError("authorization", "csrf_invalid");
      }
    }
    return structuredClone(this.#actor);
  }
}

export class StandaloneAuthorization implements AuthorizationPort {
  readonly #actor: ActorContext;

  constructor(actor: ActorContext) {
    this.#actor = structuredClone(actor);
  }

  async authorize(
    request: Parameters<AuthorizationPort["authorize"]>[0],
  ): Promise<AuthorizationDecision> {
    if (
      request.actor.principalId !== this.#actor.principalId ||
      request.actor.actorId !== this.#actor.actorId ||
      request.actor.tenantId !== this.#actor.tenantId ||
      request.actor.spaceId !== this.#actor.spaceId ||
      request.resource.tenantId !== this.#actor.tenantId ||
      request.resource.spaceId !== this.#actor.spaceId
    ) {
      return { outcome: "deny", reasonCode: "standalone_scope_mismatch" };
    }
    return { outcome: "allow" };
  }
}

/** Reads immutable release decisions from the shared Deployment Store. */
export class StoreBackedAgentVersionAdmission
  implements AgentVersionAdmissionPort
{
  readonly #releases: AgentVersionReleaseStore;

  constructor(releases: AgentVersionReleaseStore) {
    this.#releases = releases;
  }

  async evaluate(input: {
    actor: ActorContext;
    version: CompiledAgentVersion;
  }): Promise<Awaited<ReturnType<AgentVersionAdmissionPort["evaluate"]>>> {
    const active = await this.#releases.loadActiveAgentVersionRelease({
      tenantId: input.actor.tenantId,
    });
    const deployment = active?.bundle.deployments.find(
      (candidate) => candidate.agentVersionId === input.version.agentVersionId,
    );
    if (deployment === undefined) {
      return { outcome: "deny", reasonCode: "agent_version_not_deployed" };
    }
    if (deployment.contentDigest !== input.version.contentDigest) {
      return {
        outcome: "deny",
        reasonCode: "agent_version_digest_not_deployed",
      };
    }
    if (
      input.version.resources.workspaceRequired !==
      (deployment.workspaceBindingId !== null)
    ) {
      return {
        outcome: "deny",
        reasonCode: "agent_version_workspace_not_deployed",
      };
    }
    return {
      outcome: "allow",
      authorityId: deployment.authorityId,
      workspaceBindingId: deployment.workspaceBindingId,
    };
  }
}

/** Resolves an optional published version only after authorization and runtime admission. */
export class AdmittedAgentVersionRunRouteResolver
  implements RunRouteResolverPort
{
  readonly #actor: ActorContext;
  readonly #defaultAgentVersionId: string;
  readonly #agentVersions: AgentVersionApplicationService;
  readonly #digester: ContentDigester;
  readonly #admission: AgentVersionAdmissionPort;

  constructor(dependencies: {
    actor: ActorContext;
    defaultAgentVersionId: string;
    agentVersions: AgentVersionApplicationService;
    digester: ContentDigester;
    admission: AgentVersionAdmissionPort;
  }) {
    this.#actor = structuredClone(dependencies.actor);
    requireBounded(
      dependencies.defaultAgentVersionId,
      512,
      "default_agent_version_id_invalid",
    );
    this.#defaultAgentVersionId = dependencies.defaultAgentVersionId;
    this.#agentVersions = dependencies.agentVersions;
    this.#digester = dependencies.digester;
    this.#admission = dependencies.admission;
  }

  async resolveRoute(input: {
    actor: ActorContext;
    threadId: string;
    agentVersionId: string | null;
  }): Promise<RunRoute> {
    if (
      input.actor.tenantId !== this.#actor.tenantId ||
      input.actor.spaceId !== this.#actor.spaceId ||
      input.threadId.trim().length === 0
    ) {
      throw new ControlApiIdentityError(
        "authorization",
        "run_route_scope_invalid",
      );
    }
    const agentVersionId = input.agentVersionId ?? this.#defaultAgentVersionId;
    const asset = await this.#agentVersions.get(input.actor, agentVersionId);
    let version: CompiledAgentVersion;
    try {
      version = parseAgentVersionAsset(asset, this.#digester);
    } catch (error) {
      if (error instanceof AgentVersionError) {
        throw new ApplicationError(
          "internal",
          "agent_version_definition_invalid",
          {
            cause: error,
          },
        );
      }
      throw error;
    }
    const decision = await this.#admission.evaluate({
      actor: input.actor,
      version,
    });
    if (decision.outcome !== "allow") {
      throw new ApplicationError("conflict", "agent_version_not_admitted");
    }
    return {
      authorityId: decision.authorityId,
      runtimeGeneration: version.runtimeGeneration,
      agentVersionId: version.agentVersionId,
      policySnapshotId: version.policySnapshotId,
      workspaceBindingId: decision.workspaceBindingId,
    };
  }
}

export class SystemApplicationClock implements ApplicationClock {
  now(): string {
    return new Date().toISOString();
  }
}

export class NodeSha256ContentDigester implements ContentDigester {
  sha256(value: string): string {
    return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
  }
}

export class UuidV7ApplicationIdGenerator implements ApplicationIdGenerator {
  nextId(_kind: ApplicationIdKind): string {
    return uuidv7();
  }
}

export class StoreReadiness implements ControlApiReadinessPort {
  readonly #store: RunStore & AgentVersionStore & AgentVersionReleaseStore;
  readonly #tenantId: string;
  readonly #defaultAgentVersionId: string;

  constructor(
    store: RunStore & AgentVersionStore & AgentVersionReleaseStore,
    input: { tenantId: string; defaultAgentVersionId: string },
  ) {
    requireBounded(input.tenantId, 256, "default_agent_version_tenant_invalid");
    requireBounded(
      input.defaultAgentVersionId,
      512,
      "default_agent_version_id_invalid",
    );
    this.#store = store;
    this.#tenantId = input.tenantId;
    this.#defaultAgentVersionId = input.defaultAgentVersionId;
  }

  async checkReady(): Promise<void> {
    await this.#store.listPendingOutbox(1);
    const [asset, active] = await Promise.all([
      this.#store.loadAgentVersion({
        tenantId: this.#tenantId,
        agentVersionId: this.#defaultAgentVersionId,
      }),
      this.#store.loadActiveAgentVersionRelease({
        tenantId: this.#tenantId,
      }),
    ]);
    const deployment = active?.bundle.deployments.find(
      (candidate) => candidate.agentVersionId === this.#defaultAgentVersionId,
    );
    if (
      asset === null ||
      active === null ||
      active.bundle.defaultAgentVersionId !== this.#defaultAgentVersionId ||
      deployment === undefined
    ) {
      throw new Error("control_default_agent_version_not_released");
    }
    if (asset.contentDigest !== deployment.contentDigest) {
      throw new Error("control_default_agent_version_release_mismatch");
    }
  }
}

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function singleHeader(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function requireSecret(value: string, code: string): void {
  if (Buffer.byteLength(value) < 32) {
    throw new Error(code);
  }
}

function requireBounded(value: unknown, maxLength: number, code: string): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    throw new Error(code);
  }
}
