import { useRef, type ReactNode } from "react";
import { useStore } from "../store";
import { SubtitleOverlay } from "./SubtitleOverlay";

type DragMode =
  | { kind: "move"; startX: number; startY: number; origX: number; origY: number }
  | {
      kind: "resize";
      corner: "tl" | "tr" | "bl" | "br";
      startX: number;
      startY: number;
      origX: number;
      origY: number;
      origW: number;
      origH: number;
    }
  | null;

/**
 * Draggable + resizable crop rectangle, mounted inside the preview-frame in
 * custom mode. Frame is in source-pixel coordinates (e.g. 1920×1080 CSS px
 * scaled via `transform: scale(k)` by VideoPreview). Rect uses percents of
 * source for positioning so the logic scales with any source size.
 *
 * SubtitleOverlay is rendered as a child of the rect itself — its own
 * `position.*_pct`/`size.*_pct` then become relative to the crop (which is
 * exactly the target canvas on export).
 */
export function CropEditor({
  videoRef,
  guide,
}: {
  videoRef: React.RefObject<HTMLMediaElement>;
  /** Optional preview-only overlay (Reels UI guide) rendered INSIDE the crop
   * rect — the rect is the export canvas in custom mode. Purely presentational:
   * pointer-events are disabled and it never touches crop state. */
  guide?: ReactNode;
}) {
  const custom = useStore((s) => s.canvas.custom);
  const setCustomCrop = useStore((s) => s.setCustomCrop);
  const videoW = useStore((s) => s.videoW) || 1;
  const videoH = useStore((s) => s.videoH) || 1;
  const useSubs = useStore((s) => s.useSubs);
  const dragRef = useRef<DragMode>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  function parentRect(): { w: number; h: number } | null {
    // Parent is the preview-frame (logical source pixels). Its bounding box
    // reflects scaled size; percents are unaffected by scale.
    const p = rootRef.current?.parentElement;
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }

  function onPointerMove(e: PointerEvent) {
    const mode = dragRef.current;
    if (!mode) return;
    const rect = parentRect();
    if (!rect) return;
    const dxPct = ((e.clientX - mode.startX) / rect.w) * 100;
    const dyPct = ((e.clientY - mode.startY) / rect.h) * 100;
    if (mode.kind === "move") {
      setCustomCrop({
        x_pct: mode.origX + dxPct,
        y_pct: mode.origY + dyPct,
      });
    } else {
      let x = mode.origX, y = mode.origY, w = mode.origW, h = mode.origH;
      if (mode.corner === "br") { w += dxPct; h += dyPct; }
      else if (mode.corner === "tr") { w += dxPct; h -= dyPct; y += dyPct; }
      else if (mode.corner === "bl") { w -= dxPct; h += dyPct; x += dxPct; }
      else if (mode.corner === "tl") { w -= dxPct; h -= dyPct; x += dxPct; y += dyPct; }
      setCustomCrop({ x_pct: x, y_pct: y, w_pct: w, h_pct: h });
    }
  }

  function onPointerUp() {
    dragRef.current = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  }

  function startMove(e: React.PointerEvent) {
    e.stopPropagation();
    dragRef.current = {
      kind: "move",
      startX: e.clientX,
      startY: e.clientY,
      origX: custom.x_pct,
      origY: custom.y_pct,
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  function startResize(corner: "tl" | "tr" | "bl" | "br") {
    return (e: React.PointerEvent) => {
      e.stopPropagation();
      dragRef.current = {
        kind: "resize",
        corner,
        startX: e.clientX,
        startY: e.clientY,
        origX: custom.x_pct,
        origY: custom.y_pct,
        origW: custom.w_pct,
        origH: custom.h_pct,
      };
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    };
  }

  const cropPxW = Math.round((custom.w_pct / 100) * videoW);
  const cropPxH = Math.round((custom.h_pct / 100) * videoH);

  // Mask strips — dim the area outside the crop rect.
  return (
    <div ref={rootRef} data-testid="crop-editor" className="crop-editor-root">
      <div className="crop-mask crop-mask-top" style={{ height: `${custom.y_pct}%` }} />
      <div
        className="crop-mask crop-mask-bottom"
        style={{ top: `${custom.y_pct + custom.h_pct}%`, height: `${100 - custom.y_pct - custom.h_pct}%` }}
      />
      <div
        className="crop-mask crop-mask-left"
        style={{
          top: `${custom.y_pct}%`,
          height: `${custom.h_pct}%`,
          width: `${custom.x_pct}%`,
        }}
      />
      <div
        className="crop-mask crop-mask-right"
        style={{
          top: `${custom.y_pct}%`,
          height: `${custom.h_pct}%`,
          left: `${custom.x_pct + custom.w_pct}%`,
          width: `${100 - custom.x_pct - custom.w_pct}%`,
        }}
      />
      <div
        className="crop-rect"
        data-testid="crop-rect"
        style={{
          left: `${custom.x_pct}%`,
          top: `${custom.y_pct}%`,
          width: `${custom.w_pct}%`,
          height: `${custom.h_pct}%`,
        }}
        onPointerDown={startMove}
      >
        {guide}
        {useSubs && <SubtitleOverlay videoRef={videoRef} />}
        <div className="crop-handle tl" data-testid="crop-handle-tl" onPointerDown={startResize("tl")} />
        <div className="crop-handle tr" data-testid="crop-handle-tr" onPointerDown={startResize("tr")} />
        <div className="crop-handle bl" data-testid="crop-handle-bl" onPointerDown={startResize("bl")} />
        <div className="crop-handle br" data-testid="crop-handle-br" onPointerDown={startResize("br")} />
        <div className="crop-dims" data-testid="crop-dims">
          {cropPxW}×{cropPxH} px
        </div>
      </div>
    </div>
  );
}
