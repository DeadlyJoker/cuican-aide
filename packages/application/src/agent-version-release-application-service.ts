import { ApplicationError } from "./application-error.ts";
import type {
  ApplicationClock,
  ContentDigester,
} from "./application-runtime-ports.ts";
import type { AgentVersionDeploymentCandidate } from "./agent-version-deployment-store-port.ts";
import type {
  ActivateAgentVersionReleaseResult,
  AgentVersionReleaseBundle,
  AgentVersionReleaseStore,
} from "./agent-version-release-store-port.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import { RunStoreError } from "./run-store-port.ts";

/** Builds the canonical provider-neutral bundle that is signed by its digest. */
export function compileAgentVersionReleaseBundle(
  input: {
    tenantId: string;
    defaultAgentVersionId: string;
    deployments: readonly AgentVersionDeploymentCandidate[];
  },
  digester: ContentDigester,
): AgentVersionReleaseBundle {
  const deployments = [...input.deployments]
    .map(canonicalDeployment)
    .sort((left, right) =>
      left.agentVersionId < right.agentVersionId
        ? -1
        : left.agentVersionId > right.agentVersionId
          ? 1
          : 0,
    );
  const manifestDigest = digester.sha256(
    JSON.stringify({
      schemaVersion: "crewon.agent-version-release-manifest.v0",
      tenantId: input.tenantId,
      defaultAgentVersionId: input.defaultAgentVersionId,
      deployments,
    }),
  );
  return {
    schemaVersion: "crewon.agent-version-release-bundle.v0",
    tenantId: input.tenantId,
    releaseId: manifestDigest,
    manifestDigest,
    defaultAgentVersionId: input.defaultAgentVersionId,
    deployments,
  };
}

/** Authorizes one atomic bundle activation and records the exact operator. */
export class AgentVersionReleaseApplicationService {
  readonly #store: AgentVersionReleaseStore;
  readonly #authorization: AuthorizationPort;
  readonly #clock: ApplicationClock;
  readonly #digester: ContentDigester;

  constructor(dependencies: {
    store: AgentVersionReleaseStore;
    authorization: AuthorizationPort;
    clock: ApplicationClock;
    digester: ContentDigester;
  }) {
    this.#store = dependencies.store;
    this.#authorization = dependencies.authorization;
    this.#clock = dependencies.clock;
    this.#digester = dependencies.digester;
  }

  async activate(
    actor: ActorContext,
    bundle: AgentVersionReleaseBundle,
    activationId: string,
  ): Promise<ActivateAgentVersionReleaseResult> {
    validateActor(actor);
    if (bundle.tenantId !== actor.tenantId) {
      throw new ApplicationError("authorization", "authorization_denied");
    }
    const canonical = compileAgentVersionReleaseBundle(bundle, this.#digester);
    if (!sameAgentVersionReleaseBundle(canonical, bundle)) {
      throw new ApplicationError(
        "validation",
        "agent_version_release_manifest_invalid",
      );
    }
    for (const deployment of bundle.deployments) {
      await this.#authorize(actor, deployment.agentVersionId);
    }
    let active;
    try {
      const replayActivation =
        await this.#store.loadAgentVersionReleaseActivation({
          tenantId: actor.tenantId,
          activationId,
        });
      if (replayActivation !== null) {
        if (replayActivation.releaseId !== bundle.releaseId) {
          throw new RunStoreError("agent_version_release_activation_conflict");
        }
        return await this.#store.activateAgentVersionRelease({
          bundle,
          activation: replayActivation,
          expectedActiveReleaseId: replayActivation.previousReleaseId,
        });
      }
      active = await this.#store.loadActiveAgentVersionRelease({
        tenantId: actor.tenantId,
      });
      return await this.#store.activateAgentVersionRelease({
        bundle,
        activation: {
          schemaVersion: "crewon.agent-version-release-activation.v0",
          tenantId: actor.tenantId,
          releaseId: bundle.releaseId,
          activationId,
          previousReleaseId: active?.bundle.releaseId ?? null,
          operator: {
            principalId: actor.principalId,
            actorId: actor.actorId,
            spaceId: actor.spaceId,
          },
          activatedAt: this.#clock.now(),
        },
        expectedActiveReleaseId: active?.bundle.releaseId ?? null,
      });
    } catch (error) {
      if (error instanceof RunStoreError) {
        throw new ApplicationError(
          error.code.endsWith("_conflict")
            ? "conflict"
            : error.code.endsWith("_missing")
              ? "notFound"
              : error.code.startsWith("agent_version_")
                ? "validation"
                : "internal",
          error.code,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async activateExisting(
    actor: ActorContext,
    releaseId: string,
    activationId: string,
  ): Promise<ActivateAgentVersionReleaseResult> {
    validateActor(actor);
    const bundle = await this.#store.loadAgentVersionReleaseBundle({
      tenantId: actor.tenantId,
      releaseId,
    });
    if (bundle === null) {
      throw new ApplicationError("notFound", "agent_version_release_missing");
    }
    return this.activate(actor, bundle, activationId);
  }

  async #authorize(actor: ActorContext, agentVersionId: string): Promise<void> {
    try {
      const decision = await this.#authorization.authorize({
        actor,
        action: "agentVersion:deploy",
        resource: {
          kind: "agentVersion",
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          agentVersionId,
        },
      });
      if (decision.outcome !== "allow") {
        throw new ApplicationError("authorization", "authorization_denied");
      }
    } catch (error) {
      if (error instanceof ApplicationError) {
        throw error;
      }
      throw new ApplicationError("authorization", "authorization_unavailable", {
        cause: error,
      });
    }
  }
}

function canonicalDeployment(
  deployment: AgentVersionDeploymentCandidate,
): AgentVersionDeploymentCandidate {
  return {
    schemaVersion: deployment.schemaVersion,
    tenantId: deployment.tenantId,
    agentVersionId: deployment.agentVersionId,
    contentDigest: deployment.contentDigest,
    materializationDigest: deployment.materializationDigest,
    authorityId: deployment.authorityId,
    workspaceBindingId: deployment.workspaceBindingId,
  };
}

export function sameAgentVersionReleaseBundle(
  left: AgentVersionReleaseBundle,
  right: AgentVersionReleaseBundle,
): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new ApplicationError(
      "validation",
      "agent_version_release_manifest_invalid",
    );
  }
  return encoded;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateActor(actor: ActorContext): void {
  for (const value of [
    actor.principalId,
    actor.actorId,
    actor.tenantId,
    actor.spaceId,
  ]) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ApplicationError("validation", "actor_invalid");
    }
  }
}
