import { Button } from "@/components/ui/button";
import { ModalDialog } from "../shared/ModalDialog";
import {
  mcpCapabilityPresets,
  mcpEditorDraftForPreset,
  mcpPresetSetup,
  type CapabilityEditorDraft,
} from "../../lib/capability/capabilityCatalog";

export function CapabilityEditorDialog({
  busy,
  authorizationUrl,
  draft,
  error,
  onChange,
  onClose,
  onSave,
}: {
  busy: boolean;
  authorizationUrl?: string | null;
  draft: CapabilityEditorDraft | null;
  error: string | null;
  onChange: (draft: CapabilityEditorDraft) => void;
  onClose: () => void;
  onSave: () => void | Promise<void>;
}) {
  if (!draft) {
    return null;
  }

  const title = draft.kind === "skill" ? "创建技能" : "创建服务";
  const mcpSetup = draft.kind === "mcp" ? mcpPresetSetup(draft.presetId) : null;
  const mcpPresets = draft.kind === "mcp" ? mcpCapabilityPresets() : [];
  return (
    <ModalDialog
      busy={busy}
      closeLabel="关闭"
      description={
        draft.kind === "skill"
          ? "保存后写入 SKILL.md，并加入当前工作空间能力库。"
          : "选择服务并填写必要信息。MCP Server 地址和启动方式由 CrewON 维护。"
      }
      onClose={onClose}
      title={title}
    >
      <form
        className="grid gap-3.5 capability-editor-modal"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave();
        }}
      >
        <label className="form-field">
          <span>{draft.kind === "skill" ? "技能名称" : "服务名称"}</span>
          <input
            required
            value={draft.name}
            onChange={(event) =>
              onChange({ ...draft, name: event.target.value })
            }
          />
        </label>
        {draft.kind === "skill" ? (
          <>
            <label className="form-field">
              <span>描述</span>
              <textarea
                required
                rows={3}
                value={draft.description}
                onChange={(event) =>
                  onChange({ ...draft, description: event.target.value })
                }
              />
            </label>
            <label className="form-field">
              <span>工作流步骤</span>
              <textarea
                required
                rows={10}
                value={draft.workflow}
                onChange={(event) =>
                  onChange({ ...draft, workflow: event.target.value })
                }
              />
            </label>
          </>
        ) : (
          <div className="capability-editor-form">
            <label className="form-field">
              <span>服务类型</span>
              <select
                value={draft.presetId}
                onChange={(event) =>
                  onChange(mcpEditorDraftForPreset(event.target.value))
                }
              >
                <optgroup label="可直接连接">
                  {mcpPresets
                    .filter((preset) => mcpPresetSetup(preset.id).connectable)
                    .map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.title}
                        {mcpPresetSetup(preset.id).oauth ? " · 登录授权" : ""}
                      </option>
                    ))}
                </optgroup>
                <optgroup label="组织托管">
                  {mcpPresets
                    .filter((preset) => !mcpPresetSetup(preset.id).connectable)
                    .map((preset) => (
                      <option disabled key={preset.id} value={preset.id}>
                        {preset.title} · 等待组织下发
                      </option>
                    ))}
                </optgroup>
              </select>
            </label>
            <p
              className={`capability-editor-setup-note${
                mcpSetup?.connectable ? "" : " is-managed"
              }`}
            >
              {mcpSetup?.note}
            </p>
            {mcpSetup?.connectable
              ? mcpSetup.fields.map((field) => (
                  <label className="form-field" key={field.id}>
                    <span>{field.label}</span>
                    <input
                      autoComplete="off"
                      placeholder={field.placeholder}
                      required={field.required}
                      type={field.type === "password" ? "password" : "text"}
                      value={draft.values[field.id] ?? ""}
                      onChange={(event) =>
                        onChange({
                          ...draft,
                          values: {
                            ...draft.values,
                            [field.id]: event.target.value,
                          },
                        })
                      }
                    />
                  </label>
                ))
              : null}
            {authorizationUrl ? (
              <a
                className="button primary capability-editor-login-link"
                href={authorizationUrl}
                rel="noreferrer"
                target="_blank"
              >
                继续登录授权
              </a>
            ) : null}
          </div>
        )}
        {error ? (
          <p className="catalog-download-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="arrangement-modal-actions">
          <Button
            disabled={busy}
            type="button"
            variant="outline"
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            disabled={busy || mcpSetup?.connectable === false}
            type="submit"
          >
            {busy
              ? "保存中…"
              : draft.kind === "skill"
                ? "保存技能"
                : mcpSetup?.oauth
                  ? "保存并登录"
                  : "保存服务"}
          </Button>
        </footer>
      </form>
    </ModalDialog>
  );
}
