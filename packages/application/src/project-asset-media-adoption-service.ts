import type {
  ActorContext,
  AuthorizationDecision,
} from "./authorization-port.ts";
import type { ApplicationClock } from "./application-runtime-ports.ts";
import { ApplicationError } from "./application-error.ts";
import {
  parseProjectAssetMediaAdoptionRequest,
  parseProjectAssetMediaAdoptionResult,
  captureProjectAssetMediaAdoptionAuthority,
  type ProjectAssetMediaAdoptionAuthority,
  type ProjectAssetMediaAdoptionRequest,
  type ProjectAssetMediaAdoptionStore,
} from "./project-asset-media-adoption.ts";
import {
  projectAssetOwnFields,
  projectAssetBoundMethod,
} from "./project-asset-application-support.ts";
import { projectMediaResultAssertVoid } from "./project-media-result-record.ts";
import { projectAssetTimestamp } from "@crewon/domain";
import { types } from "node:util";

export type ProjectAssetMediaAdoptionPermission = Readonly<{
  actor: ActorContext;
  action:
    | "creativeProject:write"
    | "projectMediaResult:read"
    | "projectAsset:adoptMediaReference";
  /** Immutable exact target and candidate. A read/save-result permission cannot replace adoption. */
  resource: Omit<ProjectAssetMediaAdoptionRequest["query"], "idempotencyKey">;
}>;
export interface ProjectAssetMediaAdoptionAuthorizationPort {
  authorize(
    input: ProjectAssetMediaAdoptionPermission,
  ): Promise<AuthorizationDecision>;
  /** External policy/lifetime only; must not borrow the committing Store's pool. */
  authorizeTransaction(
    input: ProjectAssetMediaAdoptionPermission,
  ): Promise<AuthorizationDecision>;
  /** SQLite uses this synchronous current-policy check while holding its transaction. */
  assertActive(input: ProjectAssetMediaAdoptionPermission): void;
}

/** Shared host adoption command. Original Store proves lineage, locks, CAS and immutable recovery.
 * This service performs no generation, download or implicit candidate publication. */
export class ProjectAssetMediaAdoptionApplicationService {
  readonly #adopt: ProjectAssetMediaAdoptionStore["adoptAssetReference"];
  readonly #authorization: ProjectAssetMediaAdoptionAuthorizationPort;
  readonly #now: ApplicationClock["now"];
  constructor(
    input: Readonly<{
      store: ProjectAssetMediaAdoptionStore;
      authorization: ProjectAssetMediaAdoptionAuthorizationPort;
      clock: ApplicationClock;
    }>,
  ) {
    const d = projectAssetOwnFields(input, ["store", "authorization", "clock"]);
    this.#adopt = projectAssetBoundMethod(d.store, "adoptAssetReference");
    this.#authorization = Object.freeze({
      authorize: projectAssetBoundMethod<
        ProjectAssetMediaAdoptionAuthorizationPort["authorize"]
      >(d.authorization, "authorize"),
      authorizeTransaction: projectAssetBoundMethod<
        ProjectAssetMediaAdoptionAuthorizationPort["authorizeTransaction"]
      >(d.authorization, "authorizeTransaction"),
      assertActive: projectAssetBoundMethod<
        ProjectAssetMediaAdoptionAuthorizationPort["assertActive"]
      >(d.authorization, "assertActive"),
    });
    this.#now = projectAssetBoundMethod(d.clock, "now");
    Object.freeze(this);
  }
  async adoptReference(
    actor: ActorContext,
    query: ProjectAssetMediaAdoptionRequest["query"],
    options: Readonly<{
      signal: AbortSignal;
      authority: ProjectAssetMediaAdoptionAuthority;
    }>,
  ) {
    const request = parseProjectAssetMediaAdoptionRequest({ actor, query }),
      o = projectAssetOwnFields(options, ["signal", "authority"]);
    if (!(o.signal instanceof AbortSignal) || types.isProxy(o.signal))
      throw new ApplicationError(
        "validation",
        "project_asset_media_adoption_signal_invalid",
      );
    const signal = AbortSignal.any([o.signal, AbortSignal.timeout(30_000)]),
      invocation = captureProjectAssetMediaAdoptionAuthority(
        o.authority,
        request,
      ),
      { idempotencyKey: _, ...resource } = request.query,
      permissions = (
        [
          "creativeProject:write",
          "projectMediaResult:read",
          "projectAsset:adoptMediaReference",
        ] as const
      ).map((action) =>
        Object.freeze({
          actor: request.actor,
          action,
          resource: Object.freeze(resource),
        }),
      );
    let active = true;
    const assertActive = () => {
      if (!active)
        throw new ApplicationError(
          "authorization",
          "project_asset_media_adoption_retired",
        );
      signal.throwIfAborted();
      projectMediaResultAssertVoid(invocation.assertActive());
      for (const permission of permissions)
        projectMediaResultAssertVoid(
          this.#authorization.assertActive(permission),
        );
      signal.throwIfAborted();
    };
    const check = async (phase: "current" | "transaction") => {
      assertActive();
      if (phase === "current") await invocation.assertCurrent();
      else await invocation.assertTransactionCurrent();
      for (const permission of permissions) {
        assertActive();
        const decision = await (phase === "current"
          ? this.#authorization.authorize(permission)
          : this.#authorization.authorizeTransaction(permission));
        assertActive();
        if (decision.outcome !== "allow")
          throw new ApplicationError(
            "authorization",
            "project_asset_media_adoption_denied",
          );
      }
      assertActive();
    };
    const authority: ProjectAssetMediaAdoptionAuthority = Object.freeze({
      version: "crewon.project-asset-media-adoption-commit.v1",
      request,
      ...(invocation.uiInstallation === undefined
        ? {}
        : { uiInstallation: invocation.uiInstallation }),
      assertActive,
      assertCurrent: () => check("current"),
      assertTransactionCurrent: () => check("transaction"),
    });
    try {
      await authority.assertCurrent();
      const at = projectAssetTimestamp(this.#now());
      assertActive();
      // Do not recheck mutable project heads or permissions after COMMIT: return its durable receipt.
      // Replays still pass all current permission checks and never reselect a later changed pointer.
      return parseProjectAssetMediaAdoptionResult(
        request,
        await this.#adopt({ request, at }, authority),
      );
    } finally {
      active = false;
    }
  }
}
