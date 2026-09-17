/** A bundled, declarative task template. This is not an execution/permission API. */
export type TaskPack = Readonly<{
  schemaVersion: "crewon.task-pack.v0";
  hostApi: "crewon.task-draft.v0";
  id: string;
  version: string;
  title: Readonly<{ zh: string; en: string }>;
  description: Readonly<{ zh: string; en: string }>;
  requestedCapabilities: readonly never[];
  instructions: string;
  settings: readonly TaskPackSetting[];
}>;

export type TaskPackSetting = Readonly<{
  id: string;
  label: Readonly<{ zh: string; en: string }>;
  defaultValue: string;
  options: readonly Readonly<{
    value: string;
    label: Readonly<{ zh: string; en: string }>;
    instruction: string;
  }>[];
}>;
export type TaskPackConfiguration = Readonly<Record<string, string>>;

export class TaskPackError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "TaskPackError";
  }
}

export const exactRecord = (value: unknown, keys: readonly string[]) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new TaskPackError("task_pack_object_invalid");
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...keys].sort()))
    throw new TaskPackError("task_pack_fields_invalid");
  return value as Record<string, unknown>;
};

export const boundedText = (value: unknown, bytes: number): string => {
  if (
    typeof value !== "string" ||
    value.length > bytes ||
    !value.trim() ||
    new TextEncoder().encode(value).length > bytes ||
    value.includes("\u0000")
  )
    throw new TaskPackError("task_pack_text_invalid");
  return value;
};

const copy = (value: unknown) => {
  const record = exactRecord(value, ["zh", "en"]);
  return Object.freeze({
    zh: boundedText(record.zh, 600),
    en: boundedText(record.en, 600),
  });
};
const identifier = (value: unknown) => {
  const text = boundedText(value, 96);
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(text))
    throw new TaskPackError("task_pack_identifier_invalid");
  return text;
};
const setting = (value: unknown): TaskPackSetting => {
  const record = exactRecord(value, ["id", "label", "defaultValue", "options"]);
  if (
    !Array.isArray(record.options) ||
    record.options.length < 1 ||
    record.options.length > 8
  )
    throw new TaskPackError("task_pack_options_invalid");
  const options = record.options.map((value) => {
    const option = exactRecord(value, ["value", "label", "instruction"]);
    return Object.freeze({
      value: boundedText(option.value, 64),
      label: copy(option.label),
      instruction: boundedText(option.instruction, 500),
    });
  });
  if (
    new Set(options.map((option) => option.value)).size !== options.length ||
    !options.some((option) => option.value === record.defaultValue)
  )
    throw new TaskPackError("task_pack_options_invalid");
  return Object.freeze({
    id: identifier(record.id),
    label: copy(record.label),
    defaultValue: record.defaultValue as string,
    options: Object.freeze(options),
  });
};

/** v0 deliberately rejects scripts, tools, permissions, ranges and unknown fields. */
export const parseTaskPack = (input: unknown): TaskPack => {
  const record = exactRecord(input, [
    "schemaVersion",
    "hostApi",
    "id",
    "version",
    "title",
    "description",
    "requestedCapabilities",
    "instructions",
    "settings",
  ]);
  if (
    record.schemaVersion !== "crewon.task-pack.v0" ||
    record.hostApi !== "crewon.task-draft.v0"
  )
    throw new TaskPackError("task_pack_host_incompatible");
  const version = boundedText(record.version, 32);
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version))
    throw new TaskPackError("task_pack_version_invalid");
  if (
    !Array.isArray(record.requestedCapabilities) ||
    record.requestedCapabilities.length
  )
    throw new TaskPackError("task_pack_capabilities_unsupported");
  if (!Array.isArray(record.settings) || record.settings.length > 8)
    throw new TaskPackError("task_pack_settings_invalid");
  const settings = record.settings.map(setting);
  if (new Set(settings.map((item) => item.id)).size !== settings.length)
    throw new TaskPackError("task_pack_settings_invalid");
  return Object.freeze({
    schemaVersion: record.schemaVersion,
    hostApi: record.hostApi,
    id: identifier(record.id),
    version,
    title: copy(record.title),
    description: copy(record.description),
    requestedCapabilities: Object.freeze([]),
    instructions: boundedText(record.instructions, 4_000),
    settings: Object.freeze(settings),
  });
};

export const taskPackDefaults = (pack: TaskPack): TaskPackConfiguration =>
  Object.freeze(
    Object.fromEntries(
      pack.settings.map((field) => [field.id, field.defaultValue]),
    ),
  );

export const parseTaskPackConfiguration = (
  pack: TaskPack,
  input: unknown,
): TaskPackConfiguration => {
  const record = exactRecord(
    input,
    pack.settings.map((field) => field.id),
  );
  for (const field of pack.settings)
    if (!field.options.some((option) => option.value === record[field.id]))
      throw new TaskPackError("task_pack_setting_invalid");
  return Object.freeze({ ...record }) as TaskPackConfiguration;
};
