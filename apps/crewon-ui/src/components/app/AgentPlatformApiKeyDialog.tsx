import { useRef, useState, type FormEvent } from "react";

import { Button } from "../ui/button";
import { ModalDialog } from "../shared/ModalDialog";
import type { Locale } from "../../lib/i18n";

export function AgentPlatformApiKeyDialog({
  blockedReason = null,
  busy,
  error,
  locale,
  origin,
  onClose,
  onSubmit,
}: {
  blockedReason?: string | null;
  busy: boolean;
  error: string | null;
  locale: Locale;
  origin: string;
  onClose: () => void;
  onSubmit: (apiKey: string) => void | Promise<void>;
}) {
  const [apiKey, setApiKey] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const zh = locale === "zh";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = apiKey.trim();
    if (!normalized) return;
    void onSubmit(normalized);
  }

  return (
    <ModalDialog
      busy={busy}
      closeLabel={zh ? "关闭" : "Close"}
      description={
        zh
          ? "请在 PIM 的 API Keys 页面创建仅含 chat 权限、设置过期时间的 Key。"
          : "Create an expiring API key with only chat scope on the PIM API Keys page."
      }
      kicker="Agent Platform"
      onClose={onClose}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        inputRef.current?.focus();
      }}
      title={zh ? "配置 Agent 开放接口 Key" : "Configure Agent Open API key"}
    >
      <form className="grid gap-3.5" onSubmit={submit}>
        <label className="form-field">
          <span>{zh ? "API Key" : "API key"}</span>
          <input
            ref={inputRef}
            autoComplete="off"
            maxLength={8 * 1024}
            placeholder="bpk_…"
            required
            spellCheck={false}
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <small>
            {zh
              ? `只会加密保存到操作系统安全存储，并严格绑定 ${origin}；不会写入 Agent、数据库或运行清单。`
              : `Encrypted in OS secure storage and bound strictly to ${origin}; never written to the Agent, database, or runtime manifest.`}
          </small>
        </label>
        {error || blockedReason ? (
          <p className="team-office-create-error" role="alert">
            {blockedReason ?? error}
          </p>
        ) : null}
        <footer className="arrangement-modal-actions">
          <Button
            disabled={busy}
            type="button"
            variant="outline"
            onClick={onClose}
          >
            {zh ? "取消" : "Cancel"}
          </Button>
          <Button
            disabled={busy || Boolean(blockedReason) || !apiKey.trim()}
            type="submit"
          >
            {busy
              ? zh
                ? "安全保存并加载中…"
                : "Securely saving and loading…"
              : zh
                ? "安全保存（首次调用时验证）"
                : "Save securely (verify on first call)"}
          </Button>
        </footer>
      </form>
    </ModalDialog>
  );
}
