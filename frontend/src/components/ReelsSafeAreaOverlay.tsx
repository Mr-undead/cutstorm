/**
 * Instagram Reels UI safe-area guide — a PREVIEW-ONLY overlay.
 *
 * Draws the region of the canvas that the Reels app UI (caption, action bar,
 * …) tends to cover, so users can keep important content clear of it. The
 * percentages follow commonly documented Reels *Ads* UI guidance and are used
 * here purely as a conservative visual reference — they are NOT an official
 * mandatory safe zone for organic Reels.
 *
 * Strictly presentational:
 * - is mounted inside the element that represents the actual output canvas
 *   (`.preview-frame` in preset mode, the crop rect in custom mode), so it
 *   uses the exact same coordinate system as the existing preview/crop UI;
 * - uses percent insets so it scales with the preview at any size;
 * - is pointer-events: none, writes nothing to the store and never touches
 *   crop, canvas config, export dimensions or FFmpeg processing.
 */
export const REELS_UI_GUIDE_PCT = {
  top: 14,
  right: 6,
  bottom: 35,
  left: 6,
} as const;

export function ReelsSafeAreaOverlay() {
  const g = REELS_UI_GUIDE_PCT;
  return (
    <div
      className="reels-guide"
      data-testid="reels-guide-overlay"
      aria-hidden="true"
      style={{
        top: `${g.top}%`,
        right: `${g.right}%`,
        bottom: `${g.bottom}%`,
        left: `${g.left}%`,
      }}
    >
      <span className="reels-guide-label">Reels UI Guide</span>
    </div>
  );
}
