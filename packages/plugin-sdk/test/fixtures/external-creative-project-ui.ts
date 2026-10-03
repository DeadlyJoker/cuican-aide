import {
  createPluginCreativeProjectClient,
  type PluginCreativeProjectClient,
  type PluginUiServices,
} from "@crewon/plugin-sdk/ui";
import type { PublicCreativeProject } from "@crewon/plugin-sdk/contracts";

export function createMetadataClient(
  services: PluginUiServices,
): PluginCreativeProjectClient {
  return createPluginCreativeProjectClient(services);
}
// Every public method has a request-specific return type in the installed tarball.
export async function compileAllMethods(
  client: PluginCreativeProjectClient,
  signal: AbortSignal,
): Promise<string> {
  const projectId = "project/中文 %2F",
    assetId = "asset\\中文%";
  const options = { signal };
  const projects = await client.listProjects(
    { query: { state: "all", cursor: null, limit: 50 } },
    options,
  );
  const get = await client.getProject({ projectId }, options);
  const created = await client.createProject(
    {
      request: { title: "title", briefText: "brief" },
      idempotencyKey: "create",
    },
    options,
  );
  const renamed = await client.renameProject(
    {
      projectId,
      request: { title: "new", expectedProjectRevision: 2 },
      idempotencyKey: "rename",
    },
    options,
  );
  const state = await client.setProjectState(
    {
      projectId,
      request: { state: "archived", expectedProjectRevision: 3 },
      idempotencyKey: "state",
    },
    options,
  );
  const appended = await client.appendBrief(
    {
      projectId,
      request: { text: "brief", expectedProjectRevision: 2 },
      idempotencyKey: "brief",
    },
    options,
  );
  const brief = await client.getBrief({ projectId, briefRevision: 1 }, options);
  const briefs = await client.listBriefs(
    { projectId, query: { afterBriefRevision: 0 } },
    options,
  );
  const concept = await client.createConcept(
    {
      projectId,
      request: {
        name: "concept",
        briefRevision: 1,
        prompt: "prompt",
        expectedProjectRevision: 2,
      },
      idempotencyKey: "concept",
    },
    options,
  );
  const asset = await client.getConceptAsset({ projectId, assetId }, options);
  const assets = await client.listConceptAssets(
    { projectId, query: { afterAssetId: null } },
    options,
  );
  const revision = await client.appendConceptRevision(
    {
      projectId,
      assetId,
      request: {
        briefRevision: 1,
        prompt: "prompt",
        expectedProjectRevision: 3,
        expectedAssetMetadataRevision: 1,
      },
      idempotencyKey: "revision",
    },
    options,
  );
  const exact = await client.getConceptRevision(
    { projectId, assetId, assetRevision: 1 },
    options,
  );
  const revisions = await client.listConceptRevisions(
    { projectId, assetId, query: { afterAssetRevision: 0 } },
    options,
  );
  return [
    projects.projects.length,
    get.project.title,
    created.brief.text,
    renamed.project.title,
    state.project.state,
    appended.brief.text,
    brief.brief.text,
    briefs.briefs.length,
    concept.assetRevision.prompt,
    asset.asset.name,
    assets.assets.length,
    revision.assetRevision.assetRevision,
    exact.assetRevision.prompt,
    revisions.revisions.length,
  ].join("|");
}
export function negativeTypeBoundaries(
  client: PluginCreativeProjectClient,
  project: PublicCreativeProject,
): void {
  void client.createProject({
    // @ts-expect-error Project identity cannot be injected through the public request body.
    request: { title: "title", briefText: "brief", actorId: "forged" },
    idempotencyKey: "create",
  });
  // @ts-expect-error Metadata helpers accept numeric JSON query limits.
  void client.listProjects({ query: { limit: "20" } });
  // @ts-expect-error The public DTO remains readonly.
  project.title = "mutated";
  void client
    .getProject({ projectId: "project" })
    // @ts-expect-error Read operations do not expose a mutation receipt.
    .then((result) => result.disposition);
}
