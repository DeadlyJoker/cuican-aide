import { useEffect, type MutableRefObject } from "react";

/** A value paired with the ref that mirrors it. */
export type MirroredRef<T> = [T, MutableRefObject<T>];

/**
 * Keeps refs in step with the values they mirror.
 *
 * Callbacks that outlive a render (server notifications, keyboard handlers) read
 * current state through refs. Expressing that as a list of value/ref pairs keeps
 * the callsite proportional to the number of mirrored values instead of growing
 * by two parameters per value.
 *
 * The effect runs on every render with no dependency array: it only assigns, so
 * re-running is cheap, and listing dependencies would reintroduce the very
 * bookkeeping this replaces.
 */
export function useAppStateRefsEffect(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pairs are heterogeneous by design
  pairs: Array<MirroredRef<any>>,
) {
  useEffect(() => {
    for (const [value, ref] of pairs) {
      ref.current = value;
    }
  });
}
