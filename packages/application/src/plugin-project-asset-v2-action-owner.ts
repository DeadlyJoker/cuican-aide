import { types } from "node:util";
import {
  PROJECT_ASSET_V2_ACTIONS as actions,
  isProjectAssetV2Action,
  isProjectAssetV2MutationAction,
  parseProjectAssetV2Response,
  type ProjectAssetV2Request,
} from "@crewon/contracts/project-assets-v2";
import { MAX_PROJECT_ASSET_UI_RESPONSE_BYTES } from "@crewon/contracts/project-assets";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import { ApplicationError } from "./application-error.ts";
import { ProjectAssetV2ApplicationService } from "./project-asset-v2-application-service.ts";
import {
  projectAssetOwnFields,
  projectAssetBoundMethod,
} from "./project-asset-application-support.ts";
import {
  captureProjectTextPublications,
  type PluginProjectTextActionPublication,
} from "./plugin-project-text-action-owner.ts";
import {
  capturePluginProjectAssetV2Invocation,
  projectAssetV2ActionContext,
} from "./plugin-project-asset-v2-invocation.ts";
import { parseProjectAssetMediaAdoptionRequest } from "./project-asset-media-adoption.ts";
import { projectMediaResultAssertVoid } from "./project-media-result-record.ts";
import type { ProjectAssetCommitAuthority } from "./project-asset-commit-authority.ts";
import type {
  PluginUiActionContext,
  PluginUiActionPort,
  PluginUiCommittedMetadataPort,
  PluginUiCommittedMetadataOutcome,
  PluginUiJsonValue,
} from "./plugin-ui-ports.ts";

type Outcome = Readonly<{
  context: PluginUiActionContext;
  fingerprint: string;
  output: PluginUiJsonValue;
}>;
const outcomePrototype = Object.freeze(Object.create(null) as object);
/** Actual V2 module invocation. A metadata mutation never admits a task or gives a plugin runtime authority. */
export class PluginProjectAssetV2ActionOwner {
  readonly actions: PluginUiActionPort;
  readonly committedMetadata: PluginUiCommittedMetadataPort;
  readonly #query: ProjectAssetV2ApplicationService["query"];
  readonly #mutate: ProjectAssetV2ApplicationService["mutate"];
  readonly #adopt: ProjectAssetV2ApplicationService["adoptReference"];
  readonly #publications: readonly PluginProjectTextActionPublication[];
  readonly #authorize: (
    context: PluginUiActionContext,
    request: ProjectAssetV2Request,
  ) => Promise<void>;
  readonly #outcomes = new WeakMap<object, Outcome>();
  readonly #lifetime = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  #closing?: Promise<void>;
  constructor(
    input: Readonly<{
      assets: ProjectAssetV2ApplicationService;
      publications: readonly PluginProjectTextActionPublication[];
      authorization: Readonly<{
        authorize(
          context: PluginUiActionContext,
          request: ProjectAssetV2Request,
        ): Promise<void>;
      }>;
    }>,
  ) {
    const d = projectAssetOwnFields(input, [
      "assets",
      "publications",
      "authorization",
    ]);
    if (
      types.isProxy(d.assets) ||
      !(d.assets instanceof ProjectAssetV2ApplicationService)
    )
      throw new ApplicationError(
        "validation",
        "plugin_project_asset_v2_service_invalid",
      );
    const p = ProjectAssetV2ApplicationService.prototype;
    this.#query = p.query.bind(d.assets);
    this.#mutate = p.mutate.bind(d.assets);
    this.#adopt = p.adoptReference.bind(d.assets);
    this.#publications = captureProjectTextPublications(d.publications);
    this.#authorize = projectAssetBoundMethod(d.authorization, "authorize");
    this.actions = Object.freeze({
      invoke: (context: PluginUiActionContext) => this.#invoke(context),
    });
    this.committedMetadata = Object.freeze({
      isOutcome: (value: unknown): value is PluginUiCommittedMetadataOutcome =>
        value !== null &&
        typeof value === "object" &&
        this.#outcomes.has(value),
      verify: (
        context: PluginUiActionContext,
        outcome: PluginUiCommittedMetadataOutcome,
      ) => {
        const result = this.#outcomes.get(outcome);
        this.#outcomes.delete(outcome);
        if (
          !result ||
          result.context !== context ||
          projectAssetV2ActionContext(context).fingerprint !==
            result.fingerprint
        )
          throw new ApplicationError(
            "internal",
            "plugin_ui_committed_metadata_invalid",
          );
        return result.output;
      },
    });
    Object.freeze(this);
  }
  supportsAction(action: string): boolean {
    return isProjectAssetV2Action(action);
  }
  assertAvailable(): void {
    this.#lifetime.signal.throwIfAborted();
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#lifetime.abort(new Error("plugin_project_asset_v2_owner_closed"));
    return (this.#closing = Promise.allSettled([...this.#pending]).then(
      () => undefined,
    ));
  }
  #invoke(context: PluginUiActionContext) {
    this.assertAvailable();
    if (this.#pending.size >= 64)
      throw new ApplicationError("conflict", "plugin_project_asset_v2_busy");
    const original = capturePluginProjectAssetV2Invocation(context),
      { snapshot } = original,
      { request } = snapshot;
    this.#assertPublication(snapshot.context);
    const assertActive = () => {
      this.assertAvailable();
      original.assertActive();
    };
    const check = async (current: () => Promise<void>) => {
      assertActive();
      await current();
      assertActive();
      projectMediaResultAssertVoid(await this.#authorize(context, request));
      await current();
      assertActive();
    };
    const authority: ProjectAssetCommitAuthority = Object.freeze({
      assertActive,
      assertCurrent: () => check(original.assertCurrent),
      assertTransactionCurrent: () => check(original.assertTransactionCurrent),
      ...(original.uiTransaction === undefined
        ? {}
        : {
            uiTransaction: Object.freeze({
              ...original.uiTransaction,
              assertCurrent: () => check(original.assertTransactionCurrent),
            }),
          }),
    });
    const write =
      isProjectAssetV2MutationAction(request.action) ||
      request.action === actions.adoptMediaReference;
    const pending = (async () => {
      await authority.assertCurrent();
      let raw;
      if (request.action === actions.adoptMediaReference) {
        raw = await this.#adopt(snapshot.context.actor, request.input, {
          signal: this.#lifetime.signal,
          authority: {
            version: "crewon.project-asset-media-adoption-commit.v1",
            request: parseProjectAssetMediaAdoptionRequest({
              actor: snapshot.context.actor,
              query: request.input,
            }),
            uiInstallation: {
              installation: snapshot.installation,
              selection: snapshot.context.selection,
              package: snapshot.context.package,
            },
            assertActive,
            assertCurrent: authority.assertCurrent,
            assertTransactionCurrent: authority.assertTransactionCurrent,
          },
        });
      } else if ("request" in request.input) {
        if (!authority.uiTransaction)
          throw new ApplicationError(
            "authorization",
            "plugin_project_asset_v2_transaction_required",
          );
        raw = await this.#mutate(
          snapshot.context.actor,
          request as Extract<
            ProjectAssetV2Request,
            { input: { request: unknown } }
          >,
          { authority },
        );
      } else {
        raw = await this.#query(
          snapshot.context.actor,
          request as Exclude<
            ProjectAssetV2Request,
            | { input: { request: unknown } }
            | { action: typeof actions.adoptMediaReference }
          >,
        );
      }
      const output = parsePluginUiJsonValue(
        parseProjectAssetV2Response(request, raw),
        { maxBytes: MAX_PROJECT_ASSET_UI_RESPONSE_BYTES },
      );
      if (!write) {
        await authority.assertCurrent();
        return output;
      }
      const outcome = Object.freeze(
        Object.create(outcomePrototype),
      ) as PluginUiCommittedMetadataOutcome;
      this.#outcomes.set(outcome, {
        context,
        fingerprint: snapshot.fingerprint,
        output,
      });
      return outcome;
    })();
    this.#pending.add(pending);
    void pending.then(
      () => this.#pending.delete(pending),
      () => this.#pending.delete(pending),
    );
    return pending;
  }
  #assertPublication(context: PluginUiActionContext) {
    const d = context.lease.descriptor,
      contribution = d.contributions.find(
        (c) => c.id === context.lease.contributionId,
      ),
      dual = d.entrypoints.node !== null && d.businessManifestPath !== null;
    if (
      !this.#publications.some(
        (p) =>
          p.pluginId === d.pluginId &&
          p.packageDigest === context.package.packageDigest &&
          p.contributionId === context.lease.contributionId,
      ) ||
      contribution?.kind !== "module" ||
      contribution.slot !== "main.content" ||
      !d.requires.some(
        (r) =>
          r.service === "crewon.project-assets" &&
          r.apiVersion === "2" &&
          (!r.optional || dual),
      )
    )
      throw new ApplicationError(
        "authorization",
        "plugin_project_asset_v2_publication_unavailable",
      );
  }
}
