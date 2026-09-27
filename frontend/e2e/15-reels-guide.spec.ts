/**
 * Reels UI safe-area guide end-to-end tests (stage 2: frontend only).
 *
 * Covers:
 * - the "Reels UI Guide" toggle only appears with the Instagram Reels social
 *   preset and defaults to Off
 * - enabling it renders a preview-only overlay INSIDE the actual preview
 *   canvas (percent-based: top 14% / bottom 35% / left+right 6% → inner area
 *   88% × 51%), verified against the real preview-frame bounding box
 * - the overlay is strictly presentational: canvas config and custom crop
 *   values stay byte-identical, the crop frame keeps its position/size
 * - critical stage-1 regression combined: custom crop → drag frame → Reels →
 *   guide On → custom mode + crop frame preserved AND the guide renders
 * - turning the guide off removes the overlay
 * - Social Preset → None never leaves the Instagram-specific guide visible
 * - guide state persists across reload (persist v10)
 * - persistence migration v9 → v10 adds reelsGuide=false
 *
 * No export is exercised: the guide must never touch the export pipeline.
 */
import { test, expect, type Page } from "@playwright/test";
import { SAMPLE_5S } from "./_helpers";

async function openEditorWithVideo(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  // Subs off → fast path, no whisper.
  const subsToggle = page.getByTestId("generate-subs-toggle");
  if (await subsToggle.isChecked()) await subsToggle.click();
  await page.getByTestId("file-input").setInputFiles(SAMPLE_5S);
  await expect(page.getByTestId("style-panel")).toBeVisible({ timeout: 60_000 });
}

async function readPersisted(page: Page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("cutstorm-state");
    return raw ? JSON.parse(raw).state : null;
  });
}

/** Reels UI guide insets, as % of the hosting canvas element. */
const GUIDE = { top: 14, right: 6, bottom: 35, left: 6 };

test.describe.configure({ mode: "serial" });

test("guide toggle hidden for None, appears with Instagram Reels and defaults to Off", async ({
  page,
}) => {
  await openEditorWithVideo(page);

  await expect(page.getByTestId("reels-guide-group")).toHaveCount(0);
  await expect(page.getByTestId("reels-guide-overlay")).toHaveCount(0);

  await page.getByTestId("social-preset-instagram-reels").click();
  await expect(page.getByTestId("social-preset-instagram-reels")).toHaveClass(/active/);
  await expect(page.getByTestId("reels-guide-group")).toBeVisible();
  await expect(page.getByTestId("reels-guide-off")).toHaveClass(/active/);
  await expect(page.getByTestId("reels-guide-on")).not.toHaveClass(/active/);
  await expect(page.getByTestId("reels-guide-overlay")).toHaveCount(0);
});

test("enabled guide renders inside the preview canvas with the Reels UI geometry", async ({
  page,
}) => {
  await openEditorWithVideo(page);
  await page.getByTestId("social-preset-instagram-reels").click();
  await page.getByTestId("reels-guide-on").click();

  const guide = page.getByTestId("reels-guide-overlay");
  await expect(guide).toBeVisible();
  await expect(page.getByTestId("reels-guide-hint")).toBeVisible();

  // Geometry must come from the actual preview frame (not the viewport):
  // the overlay's bounding box is a strict percentage of the preview-wrap
  // bounding box, at any preview scale.
  const frame = await page.getByTestId("preview-wrap").boundingBox();
  const box = await guide.boundingBox();
  if (!frame || !box) throw new Error("missing preview/guide bbox");
  expect(Math.abs((box.x - frame.x) / frame.width - GUIDE.left / 100)).toBeLessThan(0.02);
  expect(Math.abs((box.y - frame.y) / frame.height - GUIDE.top / 100)).toBeLessThan(0.02);
  expect(Math.abs(box.width / frame.width - 0.88)).toBeLessThan(0.02);
  expect(Math.abs(box.height / frame.height - 0.51)).toBeLessThan(0.02);

  // Turning the guide back off removes the overlay.
  await page.getByTestId("reels-guide-off").click();
  await expect(page.getByTestId("reels-guide-overlay")).toHaveCount(0);
  await expect(page.getByTestId("reels-guide-off")).toHaveClass(/active/);
});

test("the guide does not alter the canvas configuration", async ({ page }) => {
  await openEditorWithVideo(page);
  await page.getByTestId("social-preset-instagram-reels").click();
  await expect(page.getByTestId("canvas-preset-9:16")).toHaveClass(/active/);

  const before = await readPersisted(page);
  await page.getByTestId("reels-guide-on").click();
  await expect(page.getByTestId("reels-guide-overlay")).toBeVisible();

  const after = await readPersisted(page);
  expect(after?.canvas).toEqual(before?.canvas);
  expect(after?.socialPreset).toBe("instagram-reels");
  await expect(page.getByTestId("canvas-preset-9:16")).toHaveClass(/active/);
  await expect(page.getByTestId("canvas-mode-preset")).toHaveClass(/active/);
});

test("the guide does not alter custom crop values", async ({ page }) => {
  await openEditorWithVideo(page);
  await page.getByTestId("canvas-mode-custom").click();
  await expect(page.getByTestId("crop-editor")).toBeVisible();
  // Stage-1 behaviour: Reels must not kick us out of custom mode.
  await page.getByTestId("social-preset-instagram-reels").click();
  await expect(page.getByTestId("canvas-mode-custom")).toHaveClass(/active/);

  const frame = page.getByTestId("crop-rect");
  const beforeBox = await frame.boundingBox();
  if (!beforeBox) throw new Error("no crop-rect bbox");
  const before = await readPersisted(page);

  await page.getByTestId("reels-guide-on").click();
  await expect(page.getByTestId("reels-guide-overlay")).toBeVisible();

  const after = await readPersisted(page);
  expect(after?.canvas?.custom).toEqual(before?.canvas?.custom);
  const afterBox = await frame.boundingBox();
  if (!afterBox) throw new Error("no crop-rect bbox after guide on");
  expect(Math.abs(afterBox.x - beforeBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterBox.y - beforeBox.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterBox.width - beforeBox.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterBox.height - beforeBox.height)).toBeLessThanOrEqual(1);
});

test("Reels + Reels UI Guide keep Custom crop mode and the crop frame untouched", async ({
  page,
}) => {
  await openEditorWithVideo(page);

  await page.getByTestId("canvas-mode-custom").click();
  await expect(page.getByTestId("crop-editor")).toBeVisible();

  // Move the frame so we prove the crop geometry survives Reels AND the guide.
  const frame = page.getByTestId("crop-rect");
  const beforeDrag = await frame.boundingBox();
  if (!beforeDrag) throw new Error("no crop-rect bbox");
  const startX = beforeDrag.x + beforeDrag.width / 2;
  const startY = beforeDrag.y + beforeDrag.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 40, startY - 30, { steps: 5 });
  await page.mouse.up();

  const afterDrag = await frame.boundingBox();
  if (!afterDrag) throw new Error("no crop-rect bbox after drag");
  expect(afterDrag.x).toBeLessThan(beforeDrag.x);

  await page.getByTestId("social-preset-instagram-reels").click();
  await page.getByTestId("reels-guide-on").click();

  // Custom crop mode stays active and the interactive frame stays mounted…
  await expect(page.getByTestId("canvas-mode-custom")).toHaveClass(/active/);
  await expect(page.getByTestId("preview-wrap")).toHaveAttribute("data-canvas-mode", "custom");
  await expect(page.getByTestId("crop-editor")).toBeVisible();
  // …the guide renders over the crop rect (the export canvas in this mode)…
  await expect(page.getByTestId("reels-guide-overlay")).toBeVisible();
  // …and the dragged crop frame is pixel-identical.
  const afterGuide = await frame.boundingBox();
  if (!afterGuide) throw new Error("no crop-rect bbox after guide on");
  expect(Math.abs(afterGuide.x - afterDrag.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterGuide.y - afterDrag.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterGuide.width - afterDrag.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterGuide.height - afterDrag.height)).toBeLessThanOrEqual(1);

  const state = await readPersisted(page);
  expect(state?.canvas?.mode).toBe("custom");
  expect(state?.socialPreset).toBe("instagram-reels");
});

test("manual canvas change resets the social preset and hides the Instagram guide", async ({
  page,
}) => {
  await openEditorWithVideo(page);
  await page.getByTestId("social-preset-instagram-reels").click();
  await page.getByTestId("reels-guide-on").click();
  await expect(page.getByTestId("reels-guide-overlay")).toBeVisible();

  await page.getByTestId("canvas-preset-16:9").click();
  await expect(page.getByTestId("canvas-preset-16:9")).toHaveClass(/active/);
  await expect(page.getByTestId("social-preset-none")).toHaveClass(/active/);

  // The Instagram-specific overlay must NOT linger once the social target is
  // gone — even though the stored guide preference is still "on".
  await expect(page.getByTestId("reels-guide-overlay")).toHaveCount(0);
  await expect(page.getByTestId("reels-guide-group")).toHaveCount(0);
  const state = await readPersisted(page);
  expect(state?.socialPreset).toBe("none");
  expect(state?.reelsGuide).toBe(true);
});

test("guide state persists across reload", async ({ page }) => {
  await openEditorWithVideo(page);
  await page.getByTestId("social-preset-instagram-reels").click();
  await page.getByTestId("reels-guide-on").click();
  await expect(page.getByTestId("reels-guide-overlay")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("style-panel")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("social-preset-instagram-reels")).toHaveClass(/active/);
  await expect(page.getByTestId("canvas-preset-9:16")).toHaveClass(/active/);
  await expect(page.getByTestId("reels-guide-on")).toHaveClass(/active/);
  await expect(page.getByTestId("reels-guide-overlay")).toBeVisible();
});

test("persist migrate: v9 (no reelsGuide) → v10 adds reelsGuide=false", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const v9 = {
      state: {
        videoId: null,
        videoUrl: null,
        duration: 0,
        videoW: 0,
        videoH: 0,
        segments: [{ start: 0, end: 1, text: "x", words: [] }],
        segmentsSource: [{ start: 0, end: 1, text: "x", words: [] }],
        segmentsExtra: [],
        subtitleTrack: "source",
        style: { mode: "phrase" },
        position: { x_pct: 10, y_pct: 80 },
        size: { w_pct: 80, h_pct: 15 },
        trim: { enabled: false, threshold_sec: 0.4, padding_sec: 0.08 },
        trimRange: { in_sec: 0, out_sec: 0, loop: false },
        audio: {
          sourceVolume: 1.0,
          extraAudioId: null,
          extraAudioName: null,
          extraAudioDuration: 0,
          extraVolume: 1.0,
        },
        canvas: {
          mode: "preset",
          preset: "source",
          crop_anchor: "center",
          custom: { x_pct: 10, y_pct: 10, w_pct: 80, h_pct: 80 },
          bg_color: "#000000",
        },
        socialPreset: "none",
        isAudioOnly: false,
        generateSubs: true,
        useSubs: true,
        watermark: true,
      },
      version: 9,
    };
    localStorage.setItem("cutstorm-state", JSON.stringify(v9));
  });
  await page.reload();
  await expect(page.getByTestId("file-input")).toBeVisible({ timeout: 10_000 });

  // Toggle a persisted field to force a write-back (any persisted setter works).
  const toggle = page.getByTestId("generate-subs-toggle");
  await toggle.click();
  await toggle.click();
  await page.waitForTimeout(80);

  const migrated = await page.evaluate(() => {
    const raw = localStorage.getItem("cutstorm-state");
    return raw ? JSON.parse(raw) : null;
  });
  expect(migrated?.version).toBe(10);
  expect(migrated?.state?.reelsGuide).toBe(false);
  // Previous migrations still applied — the chain isn't broken.
  expect(migrated?.state?.socialPreset).toBe("none");
  expect(migrated?.state?.subtitleTrack).toBe("source");
  expect(migrated?.state?.trimRange).toEqual({ in_sec: 0, out_sec: 0, loop: false });
});
