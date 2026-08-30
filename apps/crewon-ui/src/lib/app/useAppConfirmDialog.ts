import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type {
  ConfirmDialogRequest,
  ConfirmHandler,
} from "../shared/confirmHandler";

export function useAppConfirmDialog(): {
  confirmRequest: ConfirmDialogRequest | null;
  requestConfirm: ConfirmHandler;
  resolveConfirm: (confirmed: boolean) => void;
} {
  const [confirmRequest, setConfirmRequest] =
    useState<ConfirmDialogRequest | null>(null);
  const resolverRef = useRef<((confirmed: boolean) => void) | null>(null);

  const resolveConfirm = useCallback((confirmed: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setConfirmRequest(null);
    resolve?.(confirmed);
  }, []);

  const requestConfirm = useCallback<ConfirmHandler>(
    (message) =>
      new Promise<boolean>((resolve) => {
        resolverRef.current?.(false);
        resolverRef.current = resolve;
        setConfirmRequest({ message });
      }),
    [],
  );

  useEffect(
    () => () => {
      resolverRef.current?.(false);
      resolverRef.current = null;
    },
    [],
  );

  return {
    confirmRequest,
    requestConfirm,
    resolveConfirm,
  };
}
