import { ArrowUp, Square } from "lucide-react";
import {
  createContext,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

type SubmitBehavior = "enter" | "modifierEnter";
type PaletteIntent = "context" | "slash";
export type ComposerKeyIntent =
  | "closePalette"
  | "openContext"
  | "openSlash"
  | "send"
  | null;
export type ComposerKeyIntentInput = {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  composerValue: string;
  hasOpenPalette: boolean;
  isComposing: boolean;
  key: string;
  submitBehavior?: SubmitBehavior;
};

export function composerKeyIntent(
  input: ComposerKeyIntentInput,
): ComposerKeyIntent {
  if (input.isComposing) return null;
  if (input.key === "Escape" && input.hasOpenPalette) return "closePalette";
  if (input.key === "Enter") {
    if (input.hasOpenPalette) return null;
    if (input.metaKey || input.ctrlKey) return "send";
    return (input.submitBehavior ?? "enter") === "enter" &&
      !input.shiftKey &&
      !input.altKey
      ? "send"
      : null;
  }
  if (input.metaKey || input.ctrlKey || input.altKey) return null;
  if (input.key === "@") return "openContext";
  return input.key === "/" && /(^|\s)$/.test(input.composerValue)
    ? "openSlash"
    : null;
}

export function createComposerSubmitGuard() {
  let inFlight = false;
  return async (
    value: string,
    blocked: boolean,
    onSubmit: (value: string) => void | Promise<void>,
  ) => {
    const trimmed = value.trim();
    if (blocked || inFlight || !trimmed) return false;
    inFlight = true;
    try {
      await onSubmit(trimmed);
      return true;
    } finally {
      inFlight = false;
    }
  };
}

export function composerSubmitBlocked(input: {
  disabled: boolean;
  paletteOpen: boolean;
  submitBlocked?: boolean;
  submitting: boolean;
}) {
  return (
    input.disabled ||
    input.paletteOpen ||
    Boolean(input.submitBlocked) ||
    input.submitting
  );
}

type CoreState = {
  busy: boolean;
  paletteOpen: boolean;
  running: boolean;
  slashEnabled: boolean;
  stopLabel: string;
  submitBehavior: SubmitBehavior;
  submitBlocked: boolean;
  value: string;
  onChange: (value: string) => void;
  onClosePalette?: () => void;
  onOpenPalette?: (intent: PaletteIntent) => void;
  onStop?: () => void;
  submit: () => void;
};
type FormProps = {
  children: ReactNode;
  className: string;
  dataCommandComposer?: boolean;
  dataOdId?: string;
  disabled: boolean;
  paletteOpen?: boolean;
  running?: boolean;
  slashEnabled?: boolean;
  stopLabel?: string;
  submitBehavior: SubmitBehavior;
  submitting?: boolean;
  submitBlocked?: boolean;
  value: string;
  onChange: (value: string) => void;
  onClosePalette?: () => void;
  onOpenPalette?: (intent: PaletteIntent) => void;
  onStop?: () => void;
  onSubmit: (value: string) => void | Promise<void>;
};

const Context = createContext<CoreState | null>(null);
function useCore() {
  const core = useContext(Context);
  if (!core) throw new Error("ComposerCore parts require ComposerCore.Form");
  return core;
}

function ComposerForm({
  children,
  className,
  dataCommandComposer = false,
  dataOdId,
  disabled,
  paletteOpen = false,
  running = false,
  slashEnabled = true,
  stopLabel = "Stop",
  submitBehavior,
  submitting = false,
  submitBlocked = false,
  value,
  onChange,
  onClosePalette,
  onOpenPalette,
  onStop,
  onSubmit,
}: FormProps) {
  const guardRef = useRef(createComposerSubmitGuard());
  const [pending, setPending] = useState(false);
  const busy = disabled || submitting || pending;
  async function submitValue() {
    if (paletteOpen) return;
    if (running) return onStop?.();
    setPending(true);
    try {
      await guardRef.current(
        value,
        composerSubmitBlocked({
          disabled,
          paletteOpen,
          submitBlocked,
          submitting,
        }),
        onSubmit,
      );
    } finally {
      setPending(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitValue();
  }
  const state: CoreState = {
    busy,
    paletteOpen,
    running,
    slashEnabled,
    stopLabel,
    submitBehavior,
    submitBlocked,
    value,
    onChange,
    onClosePalette,
    onOpenPalette,
    onStop,
    submit: () => void submitValue(),
  };
  return (
    <Context.Provider value={state}>
      <form
        className={className}
        data-command-composer={dataCommandComposer || undefined}
        data-od-id={dataOdId}
        onSubmit={submit}
      >
        {children}
      </form>
    </Context.Provider>
  );
}

type TextareaProps = {
  ariaDescribedBy?: string;
  ariaInvalid?: boolean;
  ariaLabel: string;
  dataOdId?: string;
  id: string;
  maxHeight?: number;
  placeholder: string;
  readOnly?: boolean;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
};

function ComposerTextarea({
  ariaDescribedBy,
  ariaInvalid = false,
  ariaLabel,
  dataOdId,
  id,
  maxHeight = 168,
  placeholder,
  readOnly = false,
  textareaRef,
}: TextareaProps) {
  const core = useCore();
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const textarea = localRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  }, [core.value, maxHeight]);

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const intent = composerKeyIntent({
      altKey: event.altKey,
      composerValue: core.value,
      ctrlKey: event.ctrlKey,
      hasOpenPalette: core.paletteOpen,
      isComposing: event.nativeEvent.isComposing,
      key: event.key,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      submitBehavior: core.submitBehavior,
    });
    if (intent === "send") {
      event.preventDefault();
      core.submit();
    } else if (intent === "closePalette") {
      event.preventDefault();
      core.onClosePalette?.();
    } else if (intent === "openContext" && core.onOpenPalette) {
      event.preventDefault();
      core.onOpenPalette("context");
    } else if (
      intent === "openSlash" &&
      core.slashEnabled &&
      core.onOpenPalette
    ) {
      event.preventDefault();
      core.onOpenPalette("slash");
    }
  }

  return (
    <>
      <label className="visually-hidden" htmlFor={id}>
        {ariaLabel}
      </label>
      <textarea
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid || undefined}
        aria-label={ariaLabel}
        data-composer=""
        data-od-id={dataOdId}
        disabled={core.busy}
        id={id}
        placeholder={placeholder}
        readOnly={readOnly}
        ref={(node) => {
          localRef.current = node;
          if (textareaRef) textareaRef.current = node;
        }}
        rows={2}
        value={core.value}
        onKeyDown={keyDown}
        onChange={(event) => core.onChange(event.currentTarget.value)}
      />
    </>
  );
}

function ComposerSendButton({ sendLabel }: { sendLabel: string }) {
  const core = useCore();
  const label = core.running ? core.stopLabel : sendLabel;
  return (
    <button
      aria-busy={core.busy}
      aria-label={label}
      className="send-button"
      disabled={
        !core.running && (core.busy || core.submitBlocked || !core.value.trim())
      }
      title={label}
      type={core.running ? "button" : "submit"}
      onClick={core.running ? core.onStop : undefined}
    >
      {core.running ? (
        <Square aria-hidden="true" />
      ) : (
        <ArrowUp aria-hidden="true" />
      )}
    </button>
  );
}

export const ComposerCore = {
  Form: ComposerForm,
  SendButton: ComposerSendButton,
  Textarea: ComposerTextarea,
};
