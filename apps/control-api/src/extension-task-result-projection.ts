import {
  ApplicationError,
  type ExtensionReadApplicationService,
} from "@crewon/application";

type Task = Awaited<ReturnType<ExtensionReadApplicationService["getTask"]>>;

export type VerifiedExtensionTaskImage = Readonly<{
  url: string;
  filename: string;
  /** Index in the original verified provider result, before any HTTP budget trimming. */
  resultIndex: number;
}>;

/** Shared by the unchanged task v0 view and the saved-input generation view. */
export function verifiedExtensionTaskImages(
  value: Pick<Task, "binding" | "configuration">,
  operation: Task["operations"][number],
): readonly VerifiedExtensionTaskImage[] {
  if (
    operation.status !== "succeeded" ||
    value.binding.pluginId !== "crewon.comfyui-krea2"
  )
    return [];
  if (
    operation.resultJson === null ||
    Buffer.byteLength(operation.resultJson) > 16_384
  )
    invalid();
  const result = record(JSON.parse(operation.resultJson!), ["images"]);
  if (!Array.isArray(result.images) || result.images.length > 16) invalid();
  const baseUrl = serviceUrl(value.configuration.parameters.baseUrl);
  return (result.images as unknown[]).map((entry, resultIndex) => {
    const image = record(entry, ["filename", "subfolder", "type", "url"]);
    if (
      typeof image.filename !== "string" ||
      !image.filename ||
      image.filename.length > 255 ||
      /[\\/\u0000-\u001f\u007f]/u.test(image.filename) ||
      image.filename === "." ||
      image.filename === ".." ||
      typeof image.subfolder !== "string" ||
      image.subfolder.length > 512 ||
      /[\\\u0000-\u001f\u007f]/u.test(image.subfolder) ||
      image.subfolder.startsWith("/") ||
      image.subfolder
        .split("/")
        .some((part) => part === "." || part === "..") ||
      image.type !== "output"
    )
      invalid();
    const expected = new URL(
      `/view?${new URLSearchParams({ filename: image.filename as string, subfolder: image.subfolder as string, type: "output" })}`,
      baseUrl,
    ).href;
    if (image.url !== expected || Buffer.byteLength(expected) > 2048) invalid();
    return { url: expected, filename: image.filename as string, resultIndex };
  });
}

function serviceUrl(input: unknown): URL {
  if (typeof input !== "string") invalid();
  let url: URL;
  try {
    url = new URL(input as string);
  } catch {
    invalid();
  }
  if (
    url!.protocol !== "https:" ||
    url!.username ||
    url!.password ||
    url!.search ||
    url!.hash ||
    url!.pathname !== "/"
  )
    invalid();
  return url!;
}

function record(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join("\0") !== [...keys].sort().join("\0")
  )
    invalid();
  return input as Record<string, unknown>;
}

function invalid(): never {
  throw new ApplicationError("internal", "extension_result_invalid");
}
