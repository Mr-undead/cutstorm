/**
 * Mobile bottom-tab layout end-to-end tests.
 *
 * Covers:
 * - the preview frame is fitted to the available stage box (never overflowing,
 *   never collapsed, and the box is not sized by the frame inside it)
 * - switching to the Timeline tab and back to Style re-measures the preview: the
 *   frame comes back at exactly the size it had before the switch. This is the
 *   regression test for the "preview stays stuck at the smaller Timeline-tab size
 *   until you reload" bug: the scaled frame is itself the content of the box it
 *   is measured against, so a content-sized box made the measurement
 *   self-referential and every re-measure returned the same squeezed scale.
 * - the Timeline is rendered only in its own tab, never inline in the preview
 * - the preview is re-fitted after a viewport resize
 *
 * The upload fixture is a real video, so the whole flow (upload → editor) runs
 * against the backend just like the other specs.
 */
import { test, expect, type Page } from "@playwright/test";
import { SAMPLE_5S } from "./_helpers";

// Portrait phone viewport: App switches to the mobile tab layout via the
// `(max-width: 767px)` matchMedia breakpoint.
test.use({ viewport: { width: 390, height: 844 } });

async function openMobileEditor(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  // Subs off → fast path, no whisper.
  const subsToggle = page.getByTestId("generate-subs-toggle");
  if (await subsToggle.isChecked()) await subsToggle.click();
  await page.getByTestId("file-input").setInputFiles(SAMPLE_5S);
  await expect(page.getByTestId("style-panel")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("mobile-nav")).toBeVisible();
}

type Boxes = {
  stageW: number;
  stageH: number;
  frameW: number;
  frameH: number;
  canvasW: number;
  canvasH: number;
};

/** Stage box + rendered frame box, in CSS pixels. */
async function readBoxes(page: Page): Promise<Boxes | null> {
  return page.evaluate(() => {
    const stage = document.querySelector(".preview-stage");
    const frame = document.querySelector('[data-testid="preview-wrap"]');
    if (!stage || !(frame instanceof HTMLElement)) return null;
    const s = stage.getBoundingClientRect();
    const f = frame.getBoundingClientRect();
    // The frame's inline width/height are the UNSCALED output dimensions.
    return {
      stageW: s.width,
      stageH: s.height,
      frameW: f.width,
      frameH: f.height,
      canvasW: parseFloat(frame.style.width),
      canvasH: parseFloat(frame.style.height),
    };
  });
}

/**
 * The core invariant: the rendered frame is exactly the output frame scaled by
 * min(stageW / canvasW, stageH / canvasH) for the CURRENT box. A self-referential
 * (content-sized) box satisfies this too, which is exactly why the tab round-trip
 * test compares the size before and after the switch rather than only the fit.
 */
function expectFitted(b: Boxes) {
  const scale = Math.min(b.stageW / b.canvasW, b.stageH / b.canvasH);
  expect(b.frameW).toBeGreaterThan(0);
  expect(b.frameH).toBeGreaterThan(0);
  expect(Math.abs(b.frameW - scale * b.canvasW)).toBeLessThanOrEqual(2);
  expect(Math.abs(b.frameH - scale * b.canvasH)).toBeLessThanOrEqual(2);
  // Never overflows the box…
  expect(b.frameW).toBeLessThanOrEqual(b.stageW + 1);
  expect(b.frameH).toBeLessThanOrEqual(b.stageH + 1);
  // …never collapsed to the 0.01 scale floor.
  expect(b.frameW).toBeGreaterThan(b.canvasW * 0.05);
}

test.describe.configure({ mode: "serial" });

test("mobile layout: the preview frame is fitted inside the stage box", async ({ page }) => {
  await openMobileEditor(page);

  const b = await readBoxes(page);
  if (!b) throw new Error("no preview/stage box");
  expect(b.stageW).toBeGreaterThan(0);
  expect(b.stageH).toBeGreaterThan(0);
  expectFitted(b);
  // The stage box must NOT be sized by the frame inside it: that self-reference
  // is the whole bug. A content-sized stage would equal the frame exactly.
  expect(b.stageH).toBeGreaterThan(b.frameH + 2);
});

test("mobile layout: leaving the Timeline tab restores the full-size preview", async ({ page }) => {
  await openMobileEditor(page);

  const before = await readBoxes(page);
  if (!before) throw new Error("no preview/stage box before");

  await page.getByTestId("mobile-tab-timeline").click();
  await expect(page.getByTestId("mobile-tab-timeline")).toHaveClass(/active/);
  await expect(page.getByTestId("mobile-panel").getByTestId("timeline")).toBeVisible();

  await page.getByTestId("mobile-tab-style").click();
  await expect(page.getByTestId("mobile-tab-style")).toHaveClass(/active/);
  await expect(page.getByTestId("style-panel")).toBeVisible();

  const after = await readBoxes(page);
  if (!after) throw new Error("no preview/stage box after");

  // The bug: the frame stayed at the smaller Timeline-tab size. It must come
  // back to the exact same box, and to the exact same fitted size.
  expect(Math.abs(after.stageW - before.stageW)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.stageH - before.stageH)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.frameW - before.frameW)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.frameH - before.frameH)).toBeLessThanOrEqual(1);
  // …and it is still correctly fitted for the current box, not merely restored.
  expectFitted(after);
});

test("mobile layout: every tab switch leaves the preview correctly fitted", async ({ page }) => {
  await openMobileEditor(page);

  const baseline = await readBoxes(page);
  if (!baseline) throw new Error("no baseline preview box");

  // Walk every tab, returning to Style each time — the preview must never drift,
  // whichever tab was in between.
  for (const tab of ["timeline", "subs", "export", "style"] as const) {
    await page.getByTestId(`mobile-tab-${tab}`).click();
    await expect(page.getByTestId(`mobile-tab-${tab}`)).toHaveClass(/active/);
    await page.getByTestId("mobile-tab-style").click();
    await expect(page.getByTestId("mobile-tab-style")).toHaveClass(/active/);

    const b = await readBoxes(page);
    if (!b) throw new Error(`no preview box after visiting ${tab}`);
    expect(Math.abs(b.frameW - baseline.frameW), `frame width drifted after ${tab}`).toBeLessThanOrEqual(1);
    expect(Math.abs(b.frameH - baseline.frameH), `frame height drifted after ${tab}`).toBeLessThanOrEqual(1);
  }
});

test("mobile layout: the Timeline is never duplicated inside the preview", async ({ page }) => {
  await openMobileEditor(page);

  const preview = page.getByTestId("mobile-preview");
  await expect(preview.getByTestId("timeline")).toHaveCount(0);

  await page.getByTestId("mobile-tab-timeline").click();
  await expect(page.getByTestId("mobile-tab-timeline")).toHaveClass(/active/);
  // Exactly one Timeline on screen, and it lives in the panel, not the preview.
  await expect(page.getByTestId("timeline")).toHaveCount(1);
  await expect(preview.getByTestId("timeline")).toHaveCount(0);
});

test("mobile layout: preview re-fits after a viewport resize", async ({ page }) => {
  await openMobileEditor(page);

  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(200);
  const narrow = await readBoxes(page);
  if (!narrow) throw new Error("no preview box at 360px");
  expectFitted(narrow);

  await page.setViewportSize({ width: 430, height: 780 });
  await page.waitForTimeout(200);
  const wide = await readBoxes(page);
  if (!wide) throw new Error("no preview box at 430px");
  expectFitted(wide);
  // The wider viewport must actually be reflected in the re-measured frame.
  expect(wide.stageW).toBeGreaterThan(narrow.stageW);
  expect(wide.frameW).toBeGreaterThan(narrow.frameW);
});
