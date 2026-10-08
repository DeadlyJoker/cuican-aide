import {
  createPluginProjectSourceUploadsClient,
  type PluginProjectSourceUploadsClient,
  type PluginProjectSourceUploadUiServices,
  type PluginProjectSourceUploadRawPort,
  type ProjectSourceUploadInputMap,
  type ProjectSourceUploadResponseMap,
  type ProjectSourceUploadMutationResponse,
  type ProjectSourceUploadPartLocator,
} from "@crewon/plugin-sdk/project-source-uploads";

// No DOM or Node ambient types may be required by the installed upload client.
export const createPortableSourceUploadClient = (
  services: PluginProjectSourceUploadUiServices,
  raw?: PluginProjectSourceUploadRawPort,
): PluginProjectSourceUploadsClient =>
  createPluginProjectSourceUploadsClient(services, { raw });

export function checkEverySourceUploadMethod(
  client: PluginProjectSourceUploadsClient,
  inputs: ProjectSourceUploadInputMap,
  locator: ProjectSourceUploadPartLocator,
  bytes: Uint8Array,
): void {
  const begin: Promise<ProjectSourceUploadResponseMap["begin"]> = client.begin(
    inputs.begin,
  );
  const status: Promise<ProjectSourceUploadResponseMap["status"]> =
    client.status(inputs.status);
  const prepare: Promise<ProjectSourceUploadResponseMap["prepare"]> =
    client.prepare(inputs.prepare);
  const cancel: Promise<ProjectSourceUploadResponseMap["cancel"]> =
    client.cancel(inputs.cancel);
  const part: Promise<ProjectSourceUploadMutationResponse> = client.writePart(
    locator,
    bytes,
  );
  void [begin, status, prepare, cancel, part];
  void client.begin({
    ...inputs.begin,
    // @ts-expect-error Upload JSON contains no body or base64 transport.
    bytes,
  });
  void client.writePart(
    {
      ...locator,
      // @ts-expect-error Native mount and original owner never come from a plugin locator.
      ownerPrincipalId: "foreign",
    },
    bytes,
  );
  // @ts-expect-error A raw byte slice is not a number array or JSON body.
  void client.writePart(locator, [1, 2, 3]);
  // @ts-expect-error The SDK cannot create another Agent conversation or Run.
  void client.prepareThread({ uploadId: "upload" });
}
