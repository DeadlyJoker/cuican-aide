import type { PluginCreativeProjectClient } from "@crewon/plugin-sdk/ui";
import type { ConceptGenerationLocator } from "@crewon/plugin-sdk/contracts";
import type { ProjectDetails } from "./creative-project-controller";
import type { ConceptSelection } from "./ConceptController.types";

/** Reads the original saved source even while a pending intent locks navigation. */
export class GenerationSourceRecovery {
  readonly #client: Pick<
    PluginCreativeProjectClient,
    "getProject" | "getBrief" | "getConceptAsset" | "getConceptRevision"
  >;
  readonly #apply: (
    details: ProjectDetails,
    selection: ConceptSelection,
  ) => void;
  #pending: AbortController | null = null;
  #disposed = false;
  constructor(
    client: PluginCreativeProjectClient,
    apply: (details: ProjectDetails, selection: ConceptSelection) => void,
  ) {
    this.#client = Object.freeze({
      getProject: client.getProject.bind(client),
      getBrief: client.getBrief.bind(client),
      getConceptAsset: client.getConceptAsset.bind(client),
      getConceptRevision: client.getConceptRevision.bind(client),
    });
    this.#apply = apply;
  }
  async restore(request: Readonly<{ reference: ConceptGenerationLocator }>) {
    if (this.#disposed) return false;
    this.abort();
    const controller = new AbortController();
    this.#pending = controller;
    const current = () =>
      !this.#disposed &&
      this.#pending === controller &&
      !controller.signal.aborted;
    const { projectId, assetId, assetRevision } = request.reference;
    const options = { signal: controller.signal };
    try {
      const { project } = await this.#client.getProject({ projectId }, options);
      if (!current()) return false;
      const { brief } = await this.#client.getBrief(
        { projectId, briefRevision: project.latestBriefRevision },
        options,
      );
      if (!current()) return false;
      const { asset } = await this.#client.getConceptAsset(
        { projectId, assetId },
        options,
      );
      if (!current()) return false;
      const { assetRevision: revision } = await this.#client.getConceptRevision(
        { projectId, assetId, assetRevision },
        options,
      );
      if (!current()) return false;
      const source =
        revision.briefRevision === brief.briefRevision
          ? brief
          : (
              await this.#client.getBrief(
                { projectId, briefRevision: revision.briefRevision },
                options,
              )
            ).brief;
      if (!current()) return false;
      if (
        source.contentDigest !== revision.briefContentDigest ||
        asset.latestAssetRevision < revision.assetRevision
      )
        return false;
      this.#apply({ project, brief }, { asset, revision, source });
      return true;
    } catch {
      return false;
    } finally {
      if (this.#pending === controller) this.#pending = null;
    }
  }
  abort() {
    this.#pending?.abort();
    this.#pending = null;
  }
  dispose() {
    this.#disposed = true;
    this.abort();
  }
}
