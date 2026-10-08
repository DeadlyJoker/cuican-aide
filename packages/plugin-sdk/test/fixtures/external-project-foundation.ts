import {
  createPluginProjectFoundationClient,
  type PluginProjectFoundationClient,
  type PluginProjectFoundationUiServices,
  type ProjectFoundationUiInputMap,
  type ProjectFoundationUiResponseMap,
} from "@crewon/plugin-sdk/project-foundation-ui";

// This entire entry must compile with ES2022, no DOM or Node ambient declarations.
export const createPortableFoundationClient = (
  services: PluginProjectFoundationUiServices,
): PluginProjectFoundationClient =>
  createPluginProjectFoundationClient(services);

export function checkEveryFoundationMethod(
  client: PluginProjectFoundationClient,
  inputs: ProjectFoundationUiInputMap,
): void {
  const create: Promise<ProjectFoundationUiResponseMap["createProject"]> =
    client.createProject(inputs.createProject);
  const foundation: Promise<ProjectFoundationUiResponseMap["getFoundation"]> =
    client.getFoundation(inputs.getFoundation);
  const update: Promise<ProjectFoundationUiResponseMap["updateParameters"]> =
    client.updateParameters(inputs.updateParameters);
  const append: Promise<ProjectFoundationUiResponseMap["appendSource"]> =
    client.appendSource(inputs.appendSource);
  const source: Promise<ProjectFoundationUiResponseMap["getSource"]> =
    client.getSource(inputs.getSource);
  const page: Promise<ProjectFoundationUiResponseMap["readSourcePage"]> =
    client.readSourcePage(inputs.readSourcePage);
  const chapters: Promise<
    ProjectFoundationUiResponseMap["listSourceChapters"]
  > = client.listSourceChapters(inputs.listSourceChapters);
  const save: Promise<ProjectFoundationUiResponseMap["saveProposal"]> =
    client.saveProposal(inputs.saveProposal);
  const confirm: Promise<ProjectFoundationUiResponseMap["confirmProposal"]> =
    client.confirmProposal(inputs.confirmProposal);
  const mode: Promise<
    ProjectFoundationUiResponseMap["chooseCreativeStartMode"]
  > = client.chooseCreativeStartMode(inputs.chooseCreativeStartMode);
  const proposal: Promise<ProjectFoundationUiResponseMap["getProposal"]> =
    client.getProposal(inputs.getProposal);
  const proposals: Promise<ProjectFoundationUiResponseMap["listProposals"]> =
    client.listProposals(inputs.listProposals);
  void [
    create,
    foundation,
    update,
    append,
    source,
    page,
    chapters,
    save,
    confirm,
    mode,
    proposal,
    proposals,
  ];
  void client.getFoundation({
    ...inputs.getFoundation,
    // @ts-expect-error Realm and principal are provided by the Host, never a UI input.
    ownerPrincipalId: "foreign",
  });
  void client.appendSource({
    ...inputs.appendSource,
    // @ts-expect-error Source adoption accepts the durable upload identity, not raw bytes.
    sourceUpload: { ...inputs.appendSource.sourceUpload, bytes: [0] },
  });
  void client.appendSource({
    ...inputs.appendSource,
    // @ts-expect-error A source preparation pointer is not a public installation authority.
    preparedPointer: "forged",
  });
  // @ts-expect-error Source and proposal pointers are readonly observations.
  inputs.confirmProposal.proposalRevision = 2;
  // @ts-expect-error This client cannot create another Agent conversation or fake a Run.
  void client.prepareThread({ projectId: "project" });
}
