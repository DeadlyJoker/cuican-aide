import { ContractValidationError } from "./contract-validation-error.ts";
import { parsePluginUiJsonValue, pluginUiFields } from "./plugin-ui-json.ts";
import {
  creativeControlDigest,
  creativeControlId,
  creativeControlTitle,
} from "./creative-project-control-support.ts";
import type {
  ProjectFoundationCreationParameters,
  ProjectFoundationOrigin,
  ProjectFoundationRevisionPointer,
  ProjectFoundationSourceUpload,
} from "./plugin-project-foundation-service.ts";

export class ProjectFoundationContractError extends ContractValidationError {
  constructor() {
    super("project_foundation_contract_invalid");
    this.name = "ProjectFoundationContractError";
  }
}
export function foundationChecked<T>(run: () => T): T {
  try {
    return run();
  } catch {
    throw new ProjectFoundationContractError();
  }
}
export function foundationContractFail(): never {
  throw new ProjectFoundationContractError();
}
export function foundationNumber(
  input: unknown,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < minimum ||
    input > maximum
  )
    foundationContractFail();
  return input;
}
export function foundationEnum<const T extends readonly (string | null)[]>(
  input: unknown,
  values: T,
): T[number] {
  if (!values.some((value) => value === input)) foundationContractFail();
  return input as T[number];
}
export function foundationOrigin(input: unknown): ProjectFoundationOrigin {
  return foundationEnum(input, ["creative", "novel"]);
}
export function foundationPointer(
  input: unknown,
): ProjectFoundationRevisionPointer | null {
  if (input === null) return null;
  const value = pluginUiFields(input, ["revision", "digest"]);
  return Object.freeze({
    revision: foundationNumber(value.revision),
    digest: creativeControlDigest(value.digest),
  });
}
export function foundationUpload(
  input: unknown,
): ProjectFoundationSourceUpload {
  const value = pluginUiFields(input, ["uploadId", "fileDigest"]);
  return Object.freeze({
    uploadId: creativeControlId(value.uploadId),
    fileDigest: creativeControlDigest(value.fileDigest),
  });
}
export function foundationScalarLength(input: string): number {
  let result = 0;
  for (const point of input) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) foundationContractFail();
    result++;
  }
  return result;
}
function retainedLabels(input: unknown): readonly string[] {
  if (!Array.isArray(input) || input.length > 64) foundationContractFail();
  const labels = input.map(creativeControlTitle);
  if (
    new Set(labels.map((label) => label.normalize("NFC"))).size !==
    labels.length
  )
    foundationContractFail();
  return Object.freeze(labels);
}
function boolean(input: unknown): boolean {
  if (typeof input !== "boolean") foundationContractFail();
  return input;
}
/** null validates structure only; the host applies the already persisted project's origin. */
export function parseProjectFoundationParameters(
  input: unknown,
  origin: ProjectFoundationOrigin | null,
): ProjectFoundationCreationParameters {
  return foundationChecked(() => {
    const value = pluginUiFields(
      parsePluginUiJsonValue(input, { maxBytes: 8192 }),
      [
        "genre",
        "episodeMode",
        "episodeCount",
        "episodeDurationSeconds",
        "aspectRatio",
        "visualStyle",
        "needsCharacters",
        "needsArt",
        "adaptation",
      ],
    );
    const episodeMode = foundationEnum(value.episodeMode, ["single", "series"]);
    const episodeCount =
      value.episodeCount === null
        ? null
        : foundationNumber(value.episodeCount, 1, 10_000);
    if (episodeMode === "single" && episodeCount !== 1)
      foundationContractFail();
    const duration =
      value.episodeDurationSeconds === null
        ? null
        : pluginUiFields(value.episodeDurationSeconds, ["minimum", "maximum"]);
    const episodeDurationSeconds =
      duration === null
        ? null
        : Object.freeze({
            minimum: foundationNumber(duration.minimum, 1, 3600),
            maximum: foundationNumber(duration.maximum, 1, 3600),
          });
    if (
      episodeDurationSeconds !== null &&
      episodeDurationSeconds.minimum > episodeDurationSeconds.maximum
    )
      foundationContractFail();
    const visualStyle = foundationEnum(value.visualStyle, [
      "semi-realistic",
      "hand-drawn",
      null,
    ]);
    const rawAdaptation =
      value.adaptation === null
        ? null
        : pluginUiFields(value.adaptation, [
            "strategy",
            "retainedCharacters",
            "retainedScenes",
          ]);
    const adaptation =
      rawAdaptation === null
        ? null
        : Object.freeze({
            strategy: foundationEnum(rawAdaptation.strategy, [
              "faithful",
              "core",
              "reimagined",
            ]),
            retainedCharacters: retainedLabels(
              rawAdaptation.retainedCharacters,
            ),
            retainedScenes: retainedLabels(rawAdaptation.retainedScenes),
          });
    if (
      (origin === "creative" && adaptation !== null) ||
      (origin === "novel" &&
        (adaptation === null ||
          episodeDurationSeconds === null ||
          visualStyle === null))
    )
      foundationContractFail();
    return Object.freeze({
      genre: value.genre === null ? null : creativeControlTitle(value.genre),
      episodeMode,
      episodeCount,
      episodeDurationSeconds,
      aspectRatio: foundationEnum(value.aspectRatio, ["16:9", "9:16"]),
      visualStyle,
      needsCharacters: boolean(value.needsCharacters),
      needsArt: boolean(value.needsArt),
      adaptation,
    });
  });
}

/** Compare public pins only. Internal owner and installation identities never enter a DTO. */
export function foundationPointerEquals(
  actual: ProjectFoundationRevisionPointer | null,
  expected: ProjectFoundationRevisionPointer | null,
): boolean {
  return actual === null || expected === null
    ? actual === expected
    : actual.revision === expected.revision &&
        actual.digest === expected.digest;
}
