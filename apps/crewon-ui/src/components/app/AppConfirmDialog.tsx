import { AlertTriangle } from "lucide-react";
import { AlertDialog as AlertDialogPrimitive } from "radix-ui";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/cn";
import type { ConfirmDialogRequest } from "../../lib/shared/confirmHandler";
import type { Locale } from "../../lib/i18n";

type AppConfirmDialogProps = {
  locale: Locale;
  request: ConfirmDialogRequest | null;
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * The overlay and content render without a Portal on purpose: the app's markup
 * tests use renderToStaticMarkup, which React portals cannot survive. The fixed
 * positioning makes the placement identical in the browser, and the Radix
 * primitives still own focus trapping, Escape dismissal, and focus return.
 */
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
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
    >
      <AlertDialogPrimitive.Overlay
        data-slot="alert-dialog-overlay"
        className={cn(
          "fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        )}
      />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          "fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg",
        )}
      >
        <AlertDialogHeader>
          <div
            aria-hidden="true"
            className="mb-2 inline-flex size-10 items-center justify-center rounded-md bg-muted text-warning *:[svg]:size-5"
          >
            <AlertTriangle />
          </div>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{request.message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogPrimitive.Content>
    </AlertDialog>
  );
}
