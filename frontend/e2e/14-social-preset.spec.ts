/**
 * Social Preset end-to-end tests (stage 1: frontend only).
 *
 * Covers:
 * - default `socialPreset === "none"`
 * - picking Instagram Reels → socialPreset="instagram-reels" + canvas 9:16
 * - clearing the social preset to "None" → canvas aspect ratio resets to
 *   "source" (the Reels-driven 9:16 frame does not linger)
 * - Instagram Reels keeps `canvas.mode` as-is, so an in-progress Custom crop
 *   (the interactive CropEditor frame) is not unmounted
 * - manually changing the Canvas away from 9:16 → socialPreset resets to "none"
 * - persistence round-trip across reload
 * - persistence migration chain v8 → v10 (adds socialPreset="none"; v10 adds
 *   the stage-2 `reelsGuide` toggle)
 *
 * The Canvas engine / export pipeline is intentionally untouched by this
 * feature, so these tests only assert store/UI behaviour — no export.
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

test.describe.configure({ mode: "serial" });

test("default social preset is None and canvas is untouched", async ({ page }) => {
  await openEditorWithVideo(page);
  await expect(page.getByTestId("social-preset-none")).toHaveClass(/active/);
  await expect(page.getByTestId("social-preset-instagram-reels")).not.toHaveClass(/active/);
});

test("Instagram Reels sets socialPreset + canvas 9:16, and canvas stays editable", async ({
  page,
}) => {
  await openEditorWithVideo(page);

  await page.getByTestId("social-preset-instagram-reels").click();

  await expect(page.getByTestId("social-preset-instagram-reels")).toHaveClass(/active/);
  // Social preset drives the Canvas to 9:16.
  await expect(page.getByTestId("canvas-preset-9:16")).toHaveClass(/active/);
  // Canvas controls are NOT disabled/hidden by the social preset.
  await expect(page.getByTestId("canvas-preset-16:9")).toBeEnabled();
  await expect(page.getByTestId("canvas-mode-custom")).toBeEnabled();
});

test("Social Preset → None resets the canvas aspect ratio back to Source", async ({ page }) => {
  await openEditorWithVideo(page);

  await page.getByTestId("social-preset-instagram-reels").click();
  await expect(page.getByTestId("canvas-preset-9:16")).toHaveClass(/active/);

  await page.getByTestId("social-preset-none").click();

  // The social target is dropped AND the Reels-driven 9:16 frame goes away —
  // the canvas falls back to the original video's own dimensions.
  await expect(page.getByTestId("social-preset-none")).toHaveClass(/active/);
  await expect(page.getByTestId("social-preset-instagram-reels")).not.toHaveClass(/active/);
  await expect(page.getByTestId("canvas-preset-source")).toHaveClass(/active/);
  await expect(page.getByTestId("canvas-preset-9:16")).not.toHaveClass(/active/);

  const state = await page.evaluate(() => {
    const raw = localStorage.getItem("cutstorm-state");
    return raw ? JSON.parse(raw).state : null;
  });
  expect(state?.socialPreset).toBe("none");
  expect(state?.canvas?.preset).toBe("source");
  // The mode is untouched — only the aspect ratio is reset.
  expect(state?.canvas?.mode).toBe("preset");
});

test("Social Preset → None keeps a Custom crop in progress but resets the aspect ratio", async ({
  page,
}) => {
  await openEditorWithVideo(page);

  await page.getByTestId("canvas-mode-custom").click();
  await expect(page.getByTestId("crop-editor")).toBeVisible();

  const frame = page.getByTestId("crop-rect");
  const beforeDrag = await frame.boundingBox();
  if (!beforeDrag) throw new Error("no crop-rect bbox");
  await page.mouse.move(beforeDrag.x + beforeDrag.width / 2, beforeDrag.y + beforeDrag.height / 2);
  await page.mouse.down();
  await page.mouse.move(beforeDrag.x + beforeDrag.width / 2 - 40, beforeDrag.y + beforeDrag.height / 2 - 30, {
    steps: 5,
  });
  await page.mouse.up();
  const afterDrag = await frame.boundingBox();
  if (!afterDrag) throw new Error("no crop-rect bbox after drag");

  await page.getByTestId("social-preset-instagram-reels").click();
  await page.getByTestId("social-preset-none").click();

  // Same rule as Reels: the canvas MODE is never forced, so the interactive
  // reframe frame stays mounted with its geometry — only the aspect ratio resets.
  await expect(page.getByTestId("canvas-mode-custom")).toHaveClass(/active/);
  await expect(page.getByTestId("preview-wrap")).toHaveAttribute("data-canvas-mode", "custom");
  await expect(page.getByTestId("crop-editor")).toBeVisible();

  const afterNone = await frame.boundingBox();
  if (!afterNone) throw new Error("no crop-rect bbox after social preset None");
  expect(Math.abs(afterNone.x - afterDrag.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterNone.y - afterDrag.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterNone.width - afterDrag.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterNone.height - afterDrag.height)).toBeLessThanOrEqual(1);

  const state = await page.evaluate(() => {
    const raw = localStorage.getItem("cutstorm-state");
    return raw ? JSON.parse(raw).state : null;
  });
  expect(state?.socialPreset).toBe("none");
  expect(state?.canvas?.preset).toBe("source");
  // Back in Preset mode the reset aspect ratio is what is selected.
  await page.getByTestId("canvas-mode-preset").click();
  await expect(page.getByTestId("canvas-preset-source")).toHaveClass(/active/);
});

test("manually changing the canvas preset resets the social preset to None", async ({
  page,
}) => {
  await openEditorWithVideo(page);

  await page.getByTestId("social-preset-instagram-reels").click();
  await expect(page.getByTestId("canvas-preset-9:16")).toHaveClass(/active/);

  await page.getByTestId("canvas-preset-16:9").click();
  await expect(page.getByTestId("canvas-preset-16:9")).toHaveClass(/active/);
  await expect(page.getByTestId("social-preset-none")).toHaveClass(/active/);
  await expect(page.getByTestId("social-preset-instagram-reels")).not.toHaveClass(/active/);
});

test("custom crop also resets the social preset to None", async ({ page }) => {
  await openEditorWithVideo(page);

  await page.getByTestId("social-preset-instagram-reels").click();
  await expect(page.getByTestId("canvas-preset-9:16")).toHaveClass(/active/);

  await page.getByTestId("canvas-mode-custom").click();
  await expect(page.getByTestId("social-preset-none")).toHaveClass(/active/);
});

test("Instagram Reels keeps Custom crop mode and the interactive crop frame", async ({
  page,
}) => {
  await openEditorWithVideo(page);

  // Custom crop is the only mode that mounts the interactive reframe frame
  // (CropEditor) over the preview.
  await page.getByTestId("canvas-mode-custom").click();
  await expect(page.getByTestId("crop-editor")).toBeVisible();

  // Move the frame first, so we prove both the mount AND the crop geometry
  // survive the social preset click.
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

  // Reels snaps the canvas PRESET to 9:16 and sets the social target, but the
  // canvas MODE must stay "custom" — forcing it back to "preset" would unmount
  // CropEditor and drop the user's in-progress reframe.
  await expect(page.getByTestId("social-preset-instagram-reels")).toHaveClass(/active/);
  await expect(page.getByTestId("canvas-mode-custom")).toHaveClass(/active/);
  await expect(page.getByTestId("preview-wrap")).toHaveAttribute("data-canvas-mode", "custom");
  await expect(page.getByTestId("crop-editor")).toBeVisible();

  const afterPreset = await frame.boundingBox();
  if (!afterPreset) throw new Error("no crop-rect bbox after social preset");
  expect(Math.abs(afterPreset.x - afterDrag.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterPreset.y - afterDrag.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterPreset.width - afterDrag.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterPreset.height - afterDrag.height)).toBeLessThanOrEqual(1);

  // Going back to a plain preset is a manual canvas change → social target
  // resets, while the 9:16 preset Reels applied is still the selected one.
  await page.getByTestId("canvas-mode-preset").click();
  await expect(page.getByTestId("canvas-mode-preset")).toHaveClass(/active/);
  await expect(page.getByTestId("canvas-preset-9:16")).toHaveClass(/active/);
  await expect(page.getByTestId("social-preset-none")).toHaveClass(/active/);
});

test("social preset persists across reload", async ({ page }) => {
  await openEditorWithVideo(page);

  await page.getByTestId("social-preset-instagram-reels").click();
  await expect(page.getByTestId("social-preset-instagram-reels")).toHaveClass(/active/);

  await page.reload();
  await expect(page.getByTestId("style-panel")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("social-preset-instagram-reels")).toHaveClass(/active/);
  await expect(page.getByTestId("canvas-preset-9:16")).toHaveClass(/active/);
});

test("persist migrate: v8 (no socialPreset) → v10 chain adds socialPreset='none'", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const v8 = {
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
        isAudioOnly: false,
        generateSubs: true,
        useSubs: true,
        watermark: true,
      },
      version: 8,
    };
    localStorage.setItem("cutstorm-state", JSON.stringify(v8));
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
  expect(migrated?.state?.socialPreset).toBe("none");
  // Previous v7→v8 migration still applied — the chain isn't broken.
  expect(migrated?.state?.subtitleTrack).toBe("source");
  expect(migrated?.state?.trimRange).toEqual({ in_sec: 0, out_sec: 0, loop: false });
});

test("persist migrate: an existing socialPreset value is not overwritten", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const existing = {
      state: {
        socialPreset: "instagram-reels",
        canvas: {
          mode: "preset",
          preset: "9:16",
          crop_anchor: "center",
          custom: { x_pct: 10, y_pct: 10, w_pct: 80, h_pct: 80 },
          bg_color: "#000000",
        },
      },
      version: 8,
    };
    localStorage.setItem("cutstorm-state", JSON.stringify(existing));
  });
  await page.reload();
  await expect(page.getByTestId("file-input")).toBeVisible({ timeout: 10_000 });

  const restored = await page.evaluate(() => {
    const raw = localStorage.getItem("cutstorm-state");
    return raw ? JSON.parse(raw) : null;
  });
  expect(restored?.state?.socialPreset).toBe("instagram-reels");
});
