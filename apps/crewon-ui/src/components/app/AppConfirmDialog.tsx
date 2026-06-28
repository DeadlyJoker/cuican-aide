import { AlertTriangle } from "lucide-react";

import type { ConfirmDialogRequest } from "../../lib/shared/confirmHandler";
import type { Locale } from "../../lib/i18n";

type AppConfirmDialogProps = {
  locale: Locale;
  request: ConfirmDialogRequest | null;
  onCancel: () => void;
  onConfirm: () => void;
};

export function AppConfirmDialog({
  locale,
  request,
  onCancel,
  onConfirm,
}: AppConfirmDialogProps) {
  if (!request) {
    return null;
  }

  const title = locale === "zh" ? "确认操作" : "Confirm action";
  const cancelLabel = locale === "zh" ? "取消" : "Cancel";
  const confirmLabel = locale === "zh" ? "继续" : "Continue";

  return (
    <div className="app-confirm-overlay" role="presentation">
      <section
        aria-labelledby="app-confirm-title"
        aria-modal="true"
        className="app-confirm-dialog"
        role="dialog"
      >
        <div className="app-confirm-icon" aria-hidden="true">
          <AlertTriangle size={18} />
        </div>
        <div className="app-confirm-content">
          <h2 id="app-confirm-title">{title}</h2>
          <p>{request.message}</p>
        </div>
        <div className="app-confirm-actions">
          <button type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            className="app-confirm-primary"
            type="button"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
