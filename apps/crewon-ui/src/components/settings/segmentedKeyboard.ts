/** Arrow steps for a segmented control, matching native radio-group behavior. */
const ARROW_STEPS: Record<string, number | undefined> = {
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -1,
};

/**
 * Resolves the segment a key press should move to, or undefined when the key is
 * not a navigation key. Selection wraps, so the ends are not dead stops.
 */
export function segmentedKeyTarget(params: {
  count: number;
  key: string;
  selectedIndex: number;
}): number | undefined {
  const step = ARROW_STEPS[params.key];
  if (step === undefined || params.count === 0) {
    return undefined;
  }
  return (params.selectedIndex + step + params.count) % params.count;
}
