import type {
  WorkflowObjectSchema,
  WorkflowValueSchema,
} from "@crewon/domain/workflow-schema";
import type { Locale } from "../../lib/i18n";
import {
  createPluginConfigurationDraft,
  type PluginConfigurationDraft,
  type PluginConfigurationDraftValidation,
} from "../../lib/plugins/pluginConfigurationSchema";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";

type FieldPath = readonly (string | number)[];
type Issue = PluginConfigurationDraftValidation["issues"][number];
type FieldProps = Readonly<{
  schema: WorkflowValueSchema;
  draft: PluginConfigurationDraft;
  onChange: (draft: PluginConfigurationDraft) => void;
  path: FieldPath;
  idPrefix: string;
  locale: Locale;
  disabled: boolean;
  issues: readonly Issue[];
}>;

export function InstalledPluginConfigurationFields({
  schema,
  draft,
  onChange,
  ...props
}: Omit<FieldProps, "schema"> & { schema: WorkflowObjectSchema }) {
  if (draft.type !== "object")
    return <UnavailableField locale={props.locale} />;
  return (
    <ObjectFields
      {...props}
      schema={schema}
      draft={draft}
      onChange={onChange}
    />
  );
}

function ObjectFields({
  schema,
  draft,
  onChange,
  ...props
}: FieldProps & {
  schema: WorkflowObjectSchema;
  draft: Extract<PluginConfigurationDraft, { type: "object" }>;
}) {
  const zh = props.locale === "zh";
  return (
    <div className="installed-plugin-configuration-fields">
      {Object.entries(schema.properties).map(([name, fieldSchema]) => {
        const field = draft.fields[name];
        if (field === undefined)
          return <UnavailableField key={name} locale={props.locale} />;
        const required = schema.required.includes(name);
        const path = [...props.path, name];
        const id = fieldId(props.idPrefix, path);
        const update = (value: PluginConfigurationDraft) =>
          onChange({
            ...draft,
            fields: { ...draft.fields, [name]: { ...field, value } },
          });
        return (
          <div
            className="installed-plugin-configuration-field"
            key={name}
            data-field-path={JSON.stringify(path)}
          >
            <div className="installed-plugin-configuration-field-header">
              <label htmlFor={id}>
                {name}
                <small>
                  {required
                    ? zh
                      ? "必填"
                      : "Required"
                    : zh
                      ? "可选"
                      : "Optional"}
                </small>
              </label>
              {!required && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={props.disabled}
                  aria-label={`${field.included ? (zh ? "移除" : "Remove") : zh ? "添加" : "Add"} ${name}`}
                  onClick={() =>
                    onChange({
                      ...draft,
                      fields: {
                        ...draft.fields,
                        [name]: {
                          ...field,
                          included: !field.included,
                          value: field.included
                            ? field.value
                            : (field.value ??
                              createPluginConfigurationDraft(fieldSchema)),
                        },
                      },
                    })
                  }
                >
                  {field.included
                    ? zh
                      ? "移除"
                      : "Remove"
                    : zh
                      ? "添加"
                      : "Add"}
                </Button>
              )}
            </div>
            {field.included && field.value !== null ? (
              <ValueField
                {...props}
                schema={fieldSchema}
                draft={field.value}
                path={path}
                onChange={update}
              />
            ) : field.included ? (
              <UnavailableField locale={props.locale} />
            ) : (
              <p className="installed-plugin-configuration-hint">
                {zh ? "未设置" : "Not set"}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ValueField(props: FieldProps) {
  const { schema, draft, disabled, onChange, path, idPrefix, locale, issues } =
    props;
  const zh = locale === "zh";
  const id = fieldId(idPrefix, path);
  const label = pathLabel(path);
  const issue = issues.find((entry) => samePath(entry.path, path));
  const accessibility = {
    id,
    "aria-label": label,
    "aria-invalid": issue !== undefined,
    "aria-describedby": issue === undefined ? undefined : `${id}-error`,
    disabled,
  };
  let control;
  switch (schema.type) {
    case "string": {
      if (draft.type !== "string") return <UnavailableField locale={locale} />;
      control =
        schema.enum === null ? (
          <Input
            {...accessibility}
            type="text"
            value={draft.value}
            onChange={(event) =>
              onChange({ type: "string", value: event.target.value })
            }
          />
        ) : (
          <Select
            disabled={disabled}
            value={
              draft.value === ""
                ? ""
                : `option:${schema.enum.indexOf(draft.value)}`
            }
            onValueChange={(value) => {
              const selected =
                schema.enum?.[Number(value.slice("option:".length))];
              if (selected !== undefined)
                onChange({ type: "string", value: selected });
            }}
          >
            <SelectTrigger {...accessibility}>
              <SelectValue placeholder={zh ? "请选择" : "Select a value"} />
            </SelectTrigger>
            <SelectContent>
              {schema.enum.map((value, index) => (
                <SelectItem value={`option:${index}`} key={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      break;
    }
    case "number":
    case "integer": {
      if (draft.type !== schema.type)
        return <UnavailableField locale={locale} />;
      control = (
        <Input
          {...accessibility}
          type="number"
          value={draft.value}
          min={schema.minimum ?? undefined}
          max={schema.maximum ?? undefined}
          step={schema.type === "integer" ? 1 : "any"}
          placeholder={
            zh
              ? schema.type === "integer"
                ? "填写整数"
                : "填写数字"
              : schema.type === "integer"
                ? "Enter an integer"
                : "Enter a number"
          }
          onChange={(event) =>
            onChange({ type: schema.type, value: event.target.value })
          }
        />
      );
      break;
    }
    case "boolean": {
      if (draft.type !== "boolean") return <UnavailableField locale={locale} />;
      control = (
        <Switch
          {...accessibility}
          checked={draft.value}
          onCheckedChange={(value) => onChange({ type: "boolean", value })}
        />
      );
      break;
    }
    case "object": {
      if (draft.type !== "object") return <UnavailableField locale={locale} />;
      control = (
        <fieldset
          id={id}
          className="installed-plugin-configuration-group"
          aria-label={label}
          disabled={disabled}
        >
          <ObjectFields {...props} schema={schema} draft={draft} />
        </fieldset>
      );
      break;
    }
    case "array": {
      if (draft.type !== "array") return <UnavailableField locale={locale} />;
      control = (
        <fieldset
          id={id}
          className="installed-plugin-configuration-group"
          aria-label={label}
          disabled={disabled}
        >
          {draft.items.length === 0 && (
            <p className="installed-plugin-configuration-hint">
              {zh ? "暂无项目" : "No items"}
            </p>
          )}
          {draft.items.map((item, index) => (
            <div
              key={index}
              className="installed-plugin-configuration-array-item"
            >
              <div className="installed-plugin-configuration-field-header">
                <span>{zh ? `项目 ${index + 1}` : `Item ${index + 1}`}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  aria-label={`${zh ? "移除" : "Remove"} ${label} ${index + 1}`}
                  onClick={() =>
                    onChange({
                      type: "array",
                      items: draft.items.filter(
                        (_, position) => position !== index,
                      ),
                    })
                  }
                >
                  {zh ? "移除" : "Remove"}
                </Button>
              </div>
              <ValueField
                {...props}
                schema={schema.items}
                draft={item}
                path={[...path, index]}
                onChange={(value) =>
                  onChange({
                    type: "array",
                    items: draft.items.map((current, position) =>
                      position === index ? value : current,
                    ),
                  })
                }
              />
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || draft.items.length >= schema.maxItems}
            aria-label={`${zh ? "添加项目" : "Add item"} ${label}`}
            onClick={() =>
              onChange({
                type: "array",
                items: [
                  ...draft.items,
                  createPluginConfigurationDraft(schema.items),
                ],
              })
            }
          >
            {zh ? "添加项目" : "Add item"}
          </Button>
          <p className="installed-plugin-configuration-hint">
            {zh
              ? `最多 ${schema.maxItems} 项`
              : `Up to ${schema.maxItems} items`}
          </p>
        </fieldset>
      );
      break;
    }
  }
  return (
    <>
      {control}
      {issue !== undefined && (
        <p
          className="installed-plugin-configuration-field-error"
          id={`${id}-error`}
        >
          {issueMessage(issue.code, zh)}
        </p>
      )}
    </>
  );
}

function UnavailableField({ locale }: { locale: Locale }) {
  return (
    <p className="installed-plugin-configuration-field-error">
      {locale === "zh"
        ? "无法读取此字段，请重新加载配置。"
        : "This field could not be read. Reload the configuration."}
    </p>
  );
}
function samePath(left: FieldPath, right: FieldPath) {
  return (
    left.length === right.length &&
    left.every((part, index) => part === right[index])
  );
}
function fieldId(prefix: string, path: FieldPath) {
  return `${prefix}-${path.map((part) => encodeURIComponent(String(part))).join("/")}`;
}
function pathLabel(path: FieldPath) {
  return path
    .map((part) => (typeof part === "number" ? `[${part + 1}]` : part))
    .join(".");
}
function issueMessage(code: string, zh: boolean) {
  switch (code) {
    case "required":
      return zh ? "请填写此项。" : "Complete this field.";
    case "invalid_string":
      return zh
        ? "请填写符合选项和长度要求的文字。"
        : "Enter text within the permitted choices and length.";
    case "invalid_number":
      return zh
        ? "请填写范围内的有效数字。"
        : "Enter a valid number within the permitted range.";
    case "max_items":
      return zh ? "项目数量超过上限。" : "Too many items.";
    case "too_large":
      return zh
        ? "配置内容超过上限。"
        : "The configuration exceeds the size limit.";
    default:
      return zh ? "请检查此项的格式。" : "Check the format of this field.";
  }
}
