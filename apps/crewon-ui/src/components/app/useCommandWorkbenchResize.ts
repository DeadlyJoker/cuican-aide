import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

const DEFAULT_WORKBENCH_WIDTH = 480;
const MIN_WORKBENCH_WIDTH = 360;
const MIN_COMMAND_AREA_WIDTH = 560;
const WORKBENCH_KEYBOARD_STEP = 24;
const WORKBENCH_WIDTH_STORAGE_KEY = "crewon:command-workbench-width:v2";

function maximumWorkbenchWidth(
  viewportWidth: number,
  conversationLeft = 0,
): number {
  return Math.max(
    MIN_WORKBENCH_WIDTH,
    viewportWidth - conversationLeft - MIN_COMMAND_AREA_WIDTH,
  );
}

function clampWorkbenchWidth(width: number, viewportWidth: number): number {
  return Math.round(
    Math.min(
      Math.max(width, MIN_WORKBENCH_WIDTH),
      maximumWorkbenchWidth(viewportWidth),
    ),
  );
}

function currentViewportWidth(): number {
  return typeof window === "undefined" ? 1440 : window.innerWidth;
}

function initialWorkbenchWidth(): number {
  if (typeof window === "undefined") {
    return DEFAULT_WORKBENCH_WIDTH;
  }
  let storedWidth: number | null = null;
  try {
    const rawWidth = window.localStorage.getItem(WORKBENCH_WIDTH_STORAGE_KEY);
    if (rawWidth !== null) {
      const parsedWidth = Number(rawWidth);
      if (Number.isFinite(parsedWidth)) {
        storedWidth = parsedWidth;
      }
    }
  } catch {
    // Storage can be unavailable in privacy-restricted desktop webviews.
  }
  return clampWorkbenchWidth(
    storedWidth ?? DEFAULT_WORKBENCH_WIDTH,
    window.innerWidth,
  );
}

function persistWorkbenchWidth(width: number) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(WORKBENCH_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Resizing remains functional when storage is unavailable.
  }
}

export function useCommandWorkbenchResize() {
  const workbenchRef = useRef<HTMLElement>(null);
  const [maximized, setMaximized] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [workbenchWidth, setWorkbenchWidth] = useState(initialWorkbenchWidth);
  const [maximumWidth, setMaximumWidth] = useState(() =>
    maximumWorkbenchWidth(currentViewportWidth()),
  );
  const [conversationLeft, setConversationLeft] = useState(0);
  const resizePointerIdRef = useRef<number | null>(null);
  const workbenchWidthRef = useRef(workbenchWidth);
  workbenchWidthRef.current = workbenchWidth;
  function currentConversationLeft() {
    const route = workbenchRef.current?.closest(".command-shell-route");
    const conversation = route?.querySelector<HTMLElement>(
      '[data-od-id="desktop-main-pane"]',
    );
    const directory = route?.querySelector<HTMLElement>(
      ".command-sidebar-context:not([hidden])",
    );
    return Math.max(
      conversation?.getBoundingClientRect().left ?? 0,
      directory?.getBoundingClientRect().right ?? 0,
    );
  }
  function currentMaximumWidth() {
    return maximumWorkbenchWidth(
      currentViewportWidth(),
      currentConversationLeft(),
    );
  }
  useEffect(() => {
    function handleWindowResize() {
      const maximum = currentMaximumWidth();
      setConversationLeft(currentConversationLeft());
      setMaximumWidth(maximum);
      setWorkbenchWidth((currentWidth) => {
        const nextWidth = Math.min(currentWidth, maximum);
        workbenchWidthRef.current = nextWidth;
        return nextWidth;
      });
    }
    handleWindowResize();
    const conversation = workbenchRef.current
      ?.closest(".command-shell-route")
      ?.querySelector<HTMLElement>('[data-od-id="desktop-main-pane"]');
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(handleWindowResize);
    if (conversation) observer?.observe(conversation);
    const directory = workbenchRef.current
      ?.closest(".command-shell-route")
      ?.querySelector<HTMLElement>(".command-sidebar-context");
    if (directory) observer?.observe(directory);
    window.addEventListener("resize", handleWindowResize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", handleWindowResize);
    };
  }, []);

  useEffect(() => {
    if (!resizing) {
      return;
    }
    const previousCursor = document.documentElement.style.cursor;
    const previousUserSelect = document.documentElement.style.userSelect;
    document.documentElement.style.cursor = "col-resize";
    document.documentElement.style.userSelect = "none";
    return () => {
      document.documentElement.style.cursor = previousCursor;
      document.documentElement.style.userSelect = previousUserSelect;
    };
  }, [resizing]);

  function updateWorkbenchWidth(nextWidth: number) {
    const maximum = currentMaximumWidth();
    const clampedWidth = Math.round(
      Math.max(MIN_WORKBENCH_WIDTH, Math.min(nextWidth, maximum)),
    );
    workbenchWidthRef.current = clampedWidth;
    setWorkbenchWidth(clampedWidth);
  }

  function handleResizePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (maximized || event.button !== 0) {
      return;
    }
    event.preventDefault();
    resizePointerIdRef.current = event.pointerId;
    /*
     * Capture is what keeps the drag alive once the pointer leaves this 9px
     * strip; without it a browser tab's iframe swallows every later move and the
     * workbench freezes mid-resize. It is still only an optimisation: losing it
     * must not abort the drag, so a failure here cannot be allowed to skip
     * `setResizing` the way a thrown error did.
     */
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Some engines reject capture for synthetic or already-released pointers.
    }
    setResizing(true);
  }

  function handleResizePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (resizePointerIdRef.current !== event.pointerId) {
      return;
    }
    const requestedWidth = currentViewportWidth() - event.clientX;
    updateWorkbenchWidth(requestedWidth);
    if (requestedWidth >= currentMaximumWidth()) {
      resizePointerIdRef.current = null;
      setResizing(false);
      setMaximized(true);
      persistWorkbenchWidth(workbenchWidthRef.current);
    }
  }

  function finishResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (resizePointerIdRef.current !== event.pointerId) {
      return;
    }
    resizePointerIdRef.current = null;
    // Releasing is best-effort for the same reason acquiring is: a throw here
    // would strand the workbench in its resizing state forever.
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Capture was already gone; nothing to release.
    }
    setResizing(false);
    persistWorkbenchWidth(workbenchWidthRef.current);
  }

  function handleResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") {
      nextWidth = workbenchWidth + WORKBENCH_KEYBOARD_STEP;
    } else if (event.key === "ArrowRight") {
      nextWidth = workbenchWidth - WORKBENCH_KEYBOARD_STEP;
    } else if (event.key === "Home") {
      nextWidth = MIN_WORKBENCH_WIDTH;
    } else if (event.key === "End") {
      event.preventDefault();
      setMaximized(true);
      return;
    }
    if (nextWidth === null) {
      return;
    }
    event.preventDefault();
    updateWorkbenchWidth(nextWidth);
    persistWorkbenchWidth(workbenchWidthRef.current);
  }

  return {
    maximized,
    workbenchRef,
    conversationLeft,
    setMaximized,
    resizing,
    workbenchWidth,
    minimumWidth: MIN_WORKBENCH_WIDTH,
    maximumWidth,
    handleResizePointerDown,
    handleResizePointerMove,
    finishResize,
    handleResizeKeyDown,
  };
}
