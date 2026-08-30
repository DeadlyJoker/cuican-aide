/*
 * The segmented control moved to `components/shared` once the Office room began
 * rendering it: feature components may not import from `components/app`. This
 * re-export keeps the existing app-side import paths working.
 */
export {
  SegmentedTabs,
  type SegmentedTabOption,
} from "../shared/SegmentedTabs";
