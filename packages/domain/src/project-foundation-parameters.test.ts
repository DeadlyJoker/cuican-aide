import assert from "node:assert/strict";
import test from "node:test";
import { CreativeProjectError } from "./creative-project-validation.ts";
import { extensionCanonicalJson } from "./extension-configuration.ts";
import { validateProjectCreationParameters } from "./project-foundation.ts";
import type { ProjectCreationParameters } from "./project-foundation.ts";

const creativeParameters: ProjectCreationParameters = {
  genre: null,
  episodeMode: "series",
  episodeCount: null,
  episodeDurationSeconds: null,
  aspectRatio: "9:16",
  visualStyle: null,
  needsCharacters: true,
  needsArt: false,
  adaptation: null,
};
const novelParameters: ProjectCreationParameters = {
  ...creativeParameters,
  episodeDurationSeconds: { minimum: 60, maximum: 120 },
  visualStyle: "semi-realistic",
  adaptation: {
    strategy: "core",
    retainedCharacters: ["主角"],
    retainedScenes: ["相遇"],
  },
};

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof CreativeProjectError && error.code === code;
}

test("episode mode is explicit: single requires one, series retains an unknown target", () => {
  const { episodeMode: _, ...missingMode } = creativeParameters;
  assert.throws(
    () => validateProjectCreationParameters(missingMode, "creative"),
    hasCode("creative_project_fields_invalid"),
  );
  assert.throws(
    () =>
      validateProjectCreationParameters(
        { ...creativeParameters, episodeMode: "auto" },
        "creative",
      ),
    hasCode("project_foundation_episode_mode_invalid"),
  );
  for (const episodeCount of [null, 2, 120]) {
    assert.throws(
      () =>
        validateProjectCreationParameters(
          { ...creativeParameters, episodeMode: "single", episodeCount },
          "creative",
        ),
      hasCode("project_foundation_episode_count_mode_mismatch"),
    );
  }
  const single = validateProjectCreationParameters(
    { ...creativeParameters, episodeMode: "single", episodeCount: 1 },
    "creative",
  );
  assert.equal(single.episodeMode, "single");
  assert.equal(single.episodeCount, 1);
  const unnumberedSeries = validateProjectCreationParameters(
    creativeParameters,
    "creative",
  );
  assert.equal(unnumberedSeries.episodeMode, "series");
  assert.equal(unnumberedSeries.episodeCount, null);
  assert.equal(
    validateProjectCreationParameters(
      { ...creativeParameters, episodeCount: 1 },
      "creative",
    ).episodeMode,
    "series",
  );
});

test("parameter validation bounds numbers, enums, exact fields, Unicode and duplicate labels", () => {
  for (const episodeCount of [0, 10_001, 1.5, Number.MAX_SAFE_INTEGER, "3"]) {
    assert.throws(
      () =>
        validateProjectCreationParameters(
          { ...creativeParameters, episodeCount },
          "creative",
        ),
      hasCode("project_foundation_parameter_number_invalid"),
    );
  }
  for (const episodeCount of [1, 120, 10_000])
    assert.equal(
      validateProjectCreationParameters(
        { ...creativeParameters, episodeCount },
        "creative",
      ).episodeCount,
      episodeCount,
    );
  assert.throws(
    () =>
      validateProjectCreationParameters(
        {
          ...novelParameters,
          episodeDurationSeconds: { minimum: 121, maximum: 120 },
        },
        "novel",
      ),
    hasCode("project_foundation_duration_invalid"),
  );
  assert.throws(
    () =>
      validateProjectCreationParameters(
        {
          ...novelParameters,
          episodeDurationSeconds: { minimum: 1, maximum: 3_601 },
        },
        "novel",
      ),
    hasCode("project_foundation_parameter_number_invalid"),
  );
  assert.deepEqual(
    validateProjectCreationParameters(
      {
        ...novelParameters,
        episodeDurationSeconds: { minimum: 1, maximum: 3_600 },
      },
      "novel",
    ).episodeDurationSeconds,
    { minimum: 1, maximum: 3_600 },
  );
  assert.throws(
    () =>
      validateProjectCreationParameters(
        { ...creativeParameters, aspectRatio: "1:1" },
        "creative",
      ),
    hasCode("project_foundation_aspect_ratio_invalid"),
  );
  assert.throws(
    () =>
      validateProjectCreationParameters(
        { ...creativeParameters, visualStyle: "photo" },
        "creative",
      ),
    hasCode("project_foundation_visual_style_invalid"),
  );
  assert.throws(
    () =>
      validateProjectCreationParameters(
        { ...creativeParameters, needsArt: "yes" },
        "creative",
      ),
    hasCode("project_foundation_parameter_boolean_invalid"),
  );
  assert.throws(
    () =>
      validateProjectCreationParameters(
        {
          ...novelParameters,
          adaptation: { ...novelParameters.adaptation!, strategy: "auto" },
        },
        "novel",
      ),
    hasCode("project_foundation_adaptation_strategy_invalid"),
  );
  assert.throws(
    () =>
      validateProjectCreationParameters(
        {
          ...novelParameters,
          adaptation: {
            ...novelParameters.adaptation!,
            retainedScenes: ["é", "e\u0301"],
          },
        },
        "novel",
      ),
    hasCode("project_foundation_retained_label_duplicate"),
  );
  assert.throws(
    () =>
      validateProjectCreationParameters(
        {
          ...novelParameters,
          adaptation: {
            ...novelParameters.adaptation!,
            retainedCharacters: Array.from(
              { length: 65 },
              (_, index) => `角色${index}`,
            ),
          },
        },
        "novel",
      ),
    hasCode("project_foundation_retained_labels_limit"),
  );
  assert.throws(
    () =>
      validateProjectCreationParameters(
        { ...creativeParameters, genre: " 未修剪 " },
        "creative",
      ),
    hasCode("creative_project_text_invalid"),
  );
  assert.throws(
    () =>
      validateProjectCreationParameters(
        { ...creativeParameters, genre: "x".repeat(161) },
        "creative",
      ),
    hasCode("creative_project_text_limit"),
  );
  assert.throws(
    () =>
      validateProjectCreationParameters(
        { ...creativeParameters, extra: null },
        "creative",
      ),
    hasCode("creative_project_fields_invalid"),
  );
  assert.throws(
    () =>
      validateProjectCreationParameters(
        { ...creativeParameters, genre: "\ud800" },
        "creative",
      ),
    hasCode("creative_project_json_invalid"),
  );
});

test("whole creation parameters use an exact 8192 UTF8-byte boundary", () => {
  const labels = Array.from(
    { length: 48 },
    (_, index) => `${String(index).padStart(2, "0")}${"x".repeat(158)}`,
  );
  const input = {
    ...novelParameters,
    adaptation: {
      ...novelParameters.adaptation!,
      retainedCharacters: labels,
      retainedScenes: [],
    },
  };
  const bytes = (value: unknown) =>
    new TextEncoder().encode(extensionCanonicalJson(value)).length;
  let remaining = 8_192 - bytes(input);
  // Leave room for the comma and the quoted, nonempty final label.
  if (remaining < 4) {
    labels[0] = labels[0]!.slice(0, -4);
    remaining += 4;
  }
  assert.ok(remaining >= 4 && remaining <= 163);
  labels.push("z".repeat(remaining - 3));
  assert.equal(bytes(input), 8_192);
  assert.equal(bytes(validateProjectCreationParameters(input, "novel")), 8_192);
  const tooLarge = {
    ...input,
    adaptation: {
      ...input.adaptation,
      retainedCharacters: [...labels.slice(0, -1), `${labels.at(-1)}z`],
    },
  };
  assert.equal(bytes(tooLarge), 8_193);
  assert.throws(
    () => validateProjectCreationParameters(tooLarge, "novel"),
    hasCode("project_foundation_parameters_limit"),
  );
});
