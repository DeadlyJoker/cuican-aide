import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { Dialog, DialogOverlay } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";

/**
 * Shared modal shell for the command surfaces, replacing the hand-rolled
 * `.modal-backdrop` pattern.
 *
 * The Radix Dialog primitives own focus trapping, Escape dismissal, outside
 * clicks, scroll locking, and the aria wiring, so each dialog only declares its
 * title, body, and footer. Overlay and Content deliberately render without a
 * Portal: the app's markup tests use renderToStaticMarkup, which React portals
 * cannot survive, and the fixed positioning makes browser placement identical.
 */
export function ModalDialog({
  busy = false,
  children,
  closeLabel,
  description,
  kicker,
  onClose,
  onOpenAutoFocus,
  size = "default",
  title,
}: {
  /** While busy, Escape and outside clicks are swallowed so an in-flight
   * submit is never interrupted by an accidental dismissal. */
  busy?: boolean;
  children: ReactNode;
  closeLabel: string;
  description?: string;
  kicker?: string;
  onClose: () => void;
  onOpenAutoFocus?: (event: Event) => void;
  size?: "default" | "wide";
  title: string;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          onClose();
        }
      }}
    >
      <DialogOverlay />
      <DialogPrimitive.Content
        aria-describedby={undefined}
        className={cn(
          "fixed top-[50%] left-[50%] z-50 grid max-h-[calc(100vh-3.5rem)] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-3.5 overflow-auto overscroll-contain rounded-lg border bg-background p-6 shadow-lg duration-200 outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          size === "default" ? "sm:max-w-lg" : "sm:max-w-3xl",
        )}
        onEscapeKeyDown={(event) => {
          if (busy) {
            event.preventDefault();
          }
        }}
        onOpenAutoFocus={onOpenAutoFocus}
        onPointerDownOutside={(event) => {
          if (busy) {
            event.preventDefault();
          }
        }}
      >
        <header className="arrangement-modal-header">
          <div>
            {kicker ? <span className="modal-kicker">{kicker}</span> : null}
            <DialogPrimitive.Title asChild>
              <h2>{title}</h2>
            </DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description asChild>
                <p>{description}</p>
              </DialogPrimitive.Description>
            ) : null}
          </div>
          <DialogPrimitive.Close asChild>
            <button
              aria-label={closeLabel}
              className="icon-action compact"
              disabled={busy}
              type="button"
            >
              <X aria-hidden="true" />
            </button>
          </DialogPrimitive.Close>
        </header>
        {children}
      </DialogPrimitive.Content>
    </Dialog>
  );
}
