import { useState, useEffect, useRef } from "react";
import type { Segment } from "../store";
import { useStore } from "../store";
import { FontPicker } from "./FontPicker";

function computeTrimPreview(
  segments: Segment[],
  duration: number,
  threshold: number,
  padding: number,
): { cuts: number; trimmed: number } {
  const words = segments.flatMap((s) => s.words ?? []).sort((a, b) => a.start - b.start);
  if (words.length === 0) return { cuts: 0, trimmed: 0 };
  let cuts = 0;
  let kept = 0;
  let curStart = Math.max(0, words[0].start - padding);
  let curEnd = words[0].end + padding;
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap > threshold) {
      cuts += 1;
      kept += curEnd - curStart;
      curStart = Math.max(curEnd, words[i].start - padding);
    }
    curEnd = Math.max(curEnd, words[i].end + padding);
  }
  curEnd = Math.min(duration || curEnd, curEnd);
  kept += Math.max(0, curEnd - curStart);
  const trimmed = Math.max(0, (duration || 0) - kept);
  return { cuts, trimmed };
}

export function StylePanel() {
  const style = useStore((s) => s.style);
  const setStyle = useStore((s) => s.setStyle);
  const hasVideo = useStore((s) => !!s.videoUrl);
  const trim = useStore((s) => s.trim);
  const setTrim = useStore((s) => s.setTrim);
  const segments = useStore((s) => s.segments);
  const duration = useStore((s) => s.duration);
  const canvas = useStore((s) => s.canvas);
  const setCanvas = useStore((s) => s.setCanvas);
  const setCustomCrop = useStore((s) => s.setCustomCrop);
  const socialPreset = useStore((s) => s.socialPreset);
  const setSocialPreset = useStore((s) => s.setSocialPreset);
  const reelsGuide = useStore((s) => s.reelsGuide);
  const setReelsGuide = useStore((s) => s.setReelsGuide);
  const isAudioOnly = useStore((s) => s.isAudioOnly);
  const videoW = useStore((s) => s.videoW);
  const videoH = useStore((s) => s.videoH);
  const useSubs = useStore((s) => s.useSubs);
  const setUseSubs = useStore((s) => s.setUseSubs);
  const watermark = useStore((s) => s.watermark);
  const setWatermark = useStore((s) => s.setWatermark);
  const subsStreaming = useStore((s) => s.subsStreaming);
  const progressPhase = useStore((s) => s.progressPhase);
  const progressPercent = useStore((s) => s.progressPercent);

  // --- Local draft state for custom-crop inputs --------------------------------
  // The old code used `value={x.toFixed(1)}` which returned a string and
  // rounded on every keystroke, preventing users from typing multi-digit or
  // decimal numbers.  Draft values are plain strings the user can type freely;
  // they are committed to the store only on blur / Enter.
  const customCrop = canvas.custom;
  const cropFocused = useRef("");
  const [draftX, setDraftX] = useState(String(customCrop.x_pct));
  const [draftY, setDraftY] = useState(String(customCrop.y_pct));
  const [draftW, setDraftW] = useState(String(customCrop.w_pct));
  const [draftH, setDraftH] = useState(String(customCrop.h_pct));

  // Sync draft ← store when values change externally (drag / resize / presets)
  // but skip the field that currently has focus so we don't clobber user input.
  useEffect(() => {
    if (cropFocused.current !== "x") setDraftX(String(customCrop.x_pct));
    if (cropFocused.current !== "y") setDraftY(String(customCrop.y_pct));
    if (cropFocused.current !== "w") setDraftW(String(customCrop.w_pct));
    if (cropFocused.current !== "h") setDraftH(String(customCrop.h_pct));
  }, [customCrop.x_pct, customCrop.y_pct, customCrop.w_pct, customCrop.h_pct]);

  function commitCrop(field: "x_pct" | "y_pct" | "w_pct" | "h_pct", raw: string) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return; // ignore NaN / Infinity
    setCustomCrop({ [field]: n });
  }

  if (!hasVideo) return null;

  const trimPreview = computeTrimPreview(segments, duration, trim.threshold_sec, trim.padding_sec);

  const presets: Array<{ key: "source" | "9:16" | "16:9" | "1:1" | "4:5"; label: string }> = isAudioOnly
    ? [
        { key: "9:16", label: "9:16" },
        { key: "16:9", label: "16:9" },
        { key: "1:1", label: "1:1" },
        { key: "4:5", label: "4:5" },
      ]
    : [
        { key: "source", label: "Source" },
        { key: "9:16", label: "9:16" },
        { key: "16:9", label: "16:9" },
        { key: "1:1", label: "1:1" },
        { key: "4:5", label: "4:5" },
      ];

  return (
    <div className="pane scroll" data-testid="style-panel">
      <div className="pane-header">
        <h2>Style</h2>
      </div>
      <div className="pane-body">
        <div className="section-title">Social Preset</div>
        <div className="section">
          <div className="pill-group" data-testid="social-preset-group">
            <button
              type="button"
              className={socialPreset === "none" ? "active" : ""}
              onClick={() => setSocialPreset("none")}
              data-testid="social-preset-none"
            >
              None
            </button>
            <button
              type="button"
              className={socialPreset === "instagram-reels" ? "active" : ""}
              onClick={() => setSocialPreset("instagram-reels")}
              data-testid="social-preset-instagram-reels"
            >
              Instagram Reels
            </button>
          </div>
          {socialPreset === "instagram-reels" && !isAudioOnly && (
            <>
              <label>
                Reels UI Guide
                <div className="pill-group" data-testid="reels-guide-group">
                  <button
                    type="button"
                    className={!reelsGuide ? "active" : ""}
                    onClick={() => setReelsGuide(false)}
                    data-testid="reels-guide-off"
                  >
                    Off
                  </button>
                  <button
                    type="button"
                    className={reelsGuide ? "active" : ""}
                    onClick={() => setReelsGuide(true)}
                    data-testid="reels-guide-on"
                  >
                    On
                  </button>
                </div>
              </label>
              <div className="section-hint" data-testid="reels-guide-hint">
                Suggested layout reference for the Reels app UI — a visual aid
                only, not an official requirement for organic Reels. Preview
                only: never changes your crop or the exported video.
              </div>
            </>
          )}
        </div>

        <div className="section-title">Canvas {isAudioOnly ? "(audio + chromakey)" : ""}</div>
        <div className="section">
          {!isAudioOnly && (
            <div className="pill-group" data-testid="canvas-mode-group">
              <button
                type="button"
                className={canvas.mode === "preset" ? "active" : ""}
                onClick={() => setCanvas({ mode: "preset" })}
                data-testid="canvas-mode-preset"
              >
                Preset
              </button>
              <button
                type="button"
                className={canvas.mode === "custom" ? "active" : ""}
                onClick={() => setCanvas({ mode: "custom" })}
                data-testid="canvas-mode-custom"
              >
                Custom crop
              </button>
            </div>
          )}

          {canvas.mode === "preset" && (
            <>
              <div className="pill-group" data-testid="canvas-preset-group">
                {presets.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    className={canvas.preset === p.key ? "active" : ""}
                    onClick={() => setCanvas({ preset: p.key })}
                    data-testid={`canvas-preset-${p.key}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              {!isAudioOnly && canvas.preset !== "source" && (() => {
                // Show anchor pills only when a crop will actually happen.
                const aspects: Record<string, [number, number]> = {
                  "9:16": [9, 16], "16:9": [16, 9], "1:1": [1, 1], "4:5": [4, 5],
                };
                const [aw, ah] = aspects[canvas.preset] ?? [1, 1];
                const srcRatio = (videoW || 1) / (videoH || 1);
                const tgtRatio = aw / ah;
                if (Math.abs(srcRatio - tgtRatio) < 0.01) return null;
                if (srcRatio > tgtRatio) {
                  // horizontal crop — left/center/right
                  return (
                    <label>
                      Crop side
                      <div className="pill-group" data-testid="canvas-anchor-group">
                        {(["left", "center", "right"] as const).map((a) => (
                          <button
                            key={a}
                            type="button"
                            className={canvas.crop_anchor === a ? "active" : ""}
                            onClick={() => setCanvas({ crop_anchor: a })}
                            data-testid={`canvas-anchor-${a}`}
                          >
                            {a[0].toUpperCase() + a.slice(1)}
                          </button>
                        ))}
                      </div>
                    </label>
                  );
                }
                // Narrower source → pad; anchor doesn't apply visually but keep bg_color picker.
                return null;
              })()}
            </>
          )}

          {!isAudioOnly && canvas.mode === "custom" && (
            <>
              <div className="section-hint">
                Drag the rectangle in the preview. Drag corners to resize. Any size, any position.
              </div>
              <div className="grid-2">
                <label>X %
                  <input
                    type="number" min={0} max={100} step={0.5}
                    data-testid="custom-x"
                    value={draftX}
                    onChange={(e) => setDraftX(e.target.value)}
                    onFocus={() => { cropFocused.current = "x"; }}
                    onBlur={(e) => { cropFocused.current = ""; commitCrop("x_pct", e.target.value); }}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  />
                </label>
                <label>Y %
                  <input
                    type="number" min={0} max={100} step={0.5}
                    data-testid="custom-y"
                    value={draftY}
                    onChange={(e) => setDraftY(e.target.value)}
                    onFocus={() => { cropFocused.current = "y"; }}
                    onBlur={(e) => { cropFocused.current = ""; commitCrop("y_pct", e.target.value); }}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  />
                </label>
                <label>W %
                  <input
                    type="number" min={5} max={100} step={0.5}
                    data-testid="custom-w"
                    value={draftW}
                    onChange={(e) => setDraftW(e.target.value)}
                    onFocus={() => { cropFocused.current = "w"; }}
                    onBlur={(e) => { cropFocused.current = ""; commitCrop("w_pct", e.target.value); }}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  />
                </label>
                <label>H %
                  <input
                    type="number" min={5} max={100} step={0.5}
                    data-testid="custom-h"
                    value={draftH}
                    onChange={(e) => setDraftH(e.target.value)}
                    onFocus={() => { cropFocused.current = "h"; }}
                    onBlur={(e) => { cropFocused.current = ""; commitCrop("h_pct", e.target.value); }}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  />
                </label>
              </div>
              <div className="section-hint" data-testid="custom-pixels">
                Export: <strong>{Math.round(canvas.custom.w_pct / 100 * videoW)}×
                {Math.round(canvas.custom.h_pct / 100 * videoH)} px</strong>
              </div>
              <div className="pill-group">
                <button
                  type="button"
                  onClick={() => setCustomCrop({ x_pct: 0, y_pct: 0, w_pct: 100, h_pct: 100 })}
                  data-testid="custom-reset"
                >Full frame</button>
                <button
                  type="button"
                  onClick={() => setCustomCrop({ x_pct: 25, y_pct: 0, w_pct: 50, h_pct: 100 })}
                  data-testid="custom-center-vertical"
                >Center vertical</button>
                <button
                  type="button"
                  onClick={() => setCustomCrop({ x_pct: 0, y_pct: 25, w_pct: 100, h_pct: 50 })}
                  data-testid="custom-center-horizontal"
                >Center horizontal</button>
              </div>
            </>
          )}

          {isAudioOnly && (
            <>
              <div className="pill-group" data-testid="canvas-preset-group">
                {presets.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    className={canvas.preset === p.key ? "active" : ""}
                    onClick={() => setCanvas({ preset: p.key })}
                    data-testid={`canvas-preset-${p.key}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <label>
                Background / chromakey
                <div className="pill-group" data-testid="bg-color-presets">
                  {[
                    ["#00B140", "Green"],
                    ["#0047BB", "Blue"],
                    ["#000000", "Black"],
                    ["#FFFFFF", "White"],
                  ].map(([color, name]) => (
                    <button
                      key={color}
                      type="button"
                      className={canvas.bg_color.toLowerCase() === color.toLowerCase() ? "active" : ""}
                      onClick={() => setCanvas({ bg_color: color })}
                      data-testid={`bg-color-preset-${name.toLowerCase()}`}
                    >
                      {name}
                    </button>
                  ))}
                </div>
                <input
                  type="color"
                  data-testid="bg-color-picker"
                  value={canvas.bg_color}
                  onChange={(e) => setCanvas({ bg_color: e.target.value.toUpperCase() })}
                />
              </label>
              <div className="section-hint">
                The exported MP4 will have this solid color as its video track. Apply chromakey
                in your NLE (iMovie / Premiere) to overlay subtitles on another video.
              </div>
            </>
          )}
        </div>

        <div className="section-title">Mode</div>
        <div className="section">
          <div className="pill-group" data-testid="mode-group">
            {(["phrase", "word", "karaoke"] as const).map((m) => (
              <button
                key={m}
                className={style.mode === m ? "active" : ""}
                onClick={() => setStyle({ mode: m })}
                data-testid={`mode-${m}`}
                type="button"
              >
                {m[0].toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>
          {(style.mode === "word" || style.mode === "karaoke") && (
            <label>
              Words per chunk
              <input
                type="number"
                min={1}
                max={12}
                data-testid="style-words-per-chunk"
                value={style.words_per_chunk}
                onChange={(e) =>
                  setStyle({ words_per_chunk: Math.max(1, Number(e.target.value)) })
                }
              />
            </label>
          )}
          {style.mode === "karaoke" && (
            <label>
              Active word color
              <input
                type="color"
                data-testid="style-active-word-color"
                value={style.active_word_color}
                onChange={(e) =>
                  setStyle({ active_word_color: e.target.value.toUpperCase() })
                }
              />
            </label>
          )}
        </div>

        <div className="section-title">Font</div>
        <div className="section">
          <label>
            Family
            <FontPicker
              value={style.font_family}
              onChange={(family) => setStyle({ font_family: family })}
            />
          </label>
          <label>
            Size
            <input
              type="number"
              min={8}
              max={200}
              data-testid="style-font-size"
              value={style.font_size}
              onChange={(e) => setStyle({ font_size: Number(e.target.value) })}
            />
          </label>
          <div className="toggle-row">
            <label className="inline-label">
              <input
                type="checkbox"
                data-testid="style-bold"
                checked={style.bold}
                onChange={(e) => setStyle({ bold: e.target.checked })}
              />
              Bold
            </label>
            <label className="inline-label">
              <input
                type="checkbox"
                data-testid="style-italic"
                checked={style.italic}
                onChange={(e) => setStyle({ italic: e.target.checked })}
              />
              Italic
            </label>
            <label className="inline-label">
              <input
                type="checkbox"
                data-testid="style-uppercase"
                checked={style.uppercase}
                onChange={(e) => setStyle({ uppercase: e.target.checked })}
              />
              Uppercase
            </label>
          </div>
        </div>

        <div className="section-title">Colors</div>
        <div className="section">
          <div className="grid-2">
            <label>
              Text
              <input
                type="color"
                data-testid="style-text-color"
                value={style.text_color}
                onChange={(e) => setStyle({ text_color: e.target.value.toUpperCase() })}
              />
            </label>
            <label>
              Outline
              <input
                type="color"
                data-testid="style-outline-color"
                value={style.outline_color}
                onChange={(e) =>
                  setStyle({ outline_color: e.target.value.toUpperCase() })
                }
              />
            </label>
          </div>
          <label>
            Outline width
            <input
              type="number"
              min={0}
              max={10}
              data-testid="style-outline-width"
              value={style.outline_width}
              onChange={(e) => setStyle({ outline_width: Number(e.target.value) })}
            />
          </label>
          <div className="grid-2">
            <label>
              Shadow offset
              <input
                type="number"
                min={0}
                max={20}
                data-testid="style-shadow-offset"
                value={style.shadow_offset}
                onChange={(e) => setStyle({ shadow_offset: Number(e.target.value) })}
              />
            </label>
            <label>
              Shadow color
              <input
                type="color"
                data-testid="style-shadow-color"
                value={style.shadow_color}
                onChange={(e) =>
                  setStyle({ shadow_color: e.target.value.toUpperCase() })
                }
              />
            </label>
          </div>
        </div>

        <div className="section-title">Background Box</div>
        <div className="section">
          <div className="grid-2">
            <label>
              Color
              <input
                type="color"
                data-testid="style-bg-color"
                value={style.bg_color}
                onChange={(e) => setStyle({ bg_color: e.target.value.toUpperCase() })}
              />
            </label>
            <label>
              Opacity
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                data-testid="style-bg-opacity"
                value={style.bg_opacity}
                onChange={(e) => setStyle({ bg_opacity: Number(e.target.value) })}
              />
            </label>
          </div>
          <div className="grid-2">
            <label>
              Padding
              <input
                type="number"
                min={0}
                max={40}
                data-testid="style-bg-padding"
                value={style.bg_padding}
                onChange={(e) => setStyle({ bg_padding: Number(e.target.value) })}
              />
            </label>
            <label>
              Radius
              <input
                type="number"
                min={0}
                max={40}
                data-testid="style-bg-radius"
                value={style.bg_radius}
                onChange={(e) => setStyle({ bg_radius: Number(e.target.value) })}
              />
            </label>
          </div>
        </div>

        <div className="section-title">Auto-cut silences</div>
        <div className="section">
          <label className="inline-label" title="Remove gaps longer than threshold on export">
            <input
              type="checkbox"
              data-testid="trim-enabled"
              checked={trim.enabled}
              onChange={(e) => setTrim({ enabled: e.target.checked })}
            />
            Trim silences on export
          </label>
          {trim.enabled && (
            <>
              <label>
                Silence threshold (sec)
                <input
                  type="range"
                  min={0.1}
                  max={2}
                  step={0.05}
                  data-testid="trim-threshold"
                  value={trim.threshold_sec}
                  onChange={(e) => setTrim({ threshold_sec: Number(e.target.value) })}
                />
                <span className="topbar-meta" data-testid="trim-threshold-value">
                  {trim.threshold_sec.toFixed(2)} sec
                </span>
              </label>
              <label>
                Padding around words (sec)
                <input
                  type="range"
                  min={0}
                  max={0.5}
                  step={0.01}
                  data-testid="trim-padding"
                  value={trim.padding_sec}
                  onChange={(e) => setTrim({ padding_sec: Number(e.target.value) })}
                />
                <span className="topbar-meta" data-testid="trim-padding-value">
                  {trim.padding_sec.toFixed(2)} sec
                </span>
              </label>
              <div className="trim-preview" data-testid="trim-preview">
                <strong>{trimPreview.cuts}</strong> gaps will be cut ·{" "}
                <strong>−{trimPreview.trimmed.toFixed(1)}s</strong> (
                {Math.round((trimPreview.trimmed / Math.max(duration, 0.01)) * 100)}% of video)
              </div>
            </>
          )}
        </div>

        <div className="section-title">Position & Timing</div>
        <div className="section">
          <label>
            Alignment
            <div className="pill-group" data-testid="alignment-group">
              {(["left", "center", "right"] as const).map((a) => (
                <button
                  key={a}
                  className={style.alignment === a ? "active" : ""}
                  onClick={() => setStyle({ alignment: a })}
                  type="button"
                >
                  {a[0].toUpperCase() + a.slice(1)}
                </button>
              ))}
            </div>
            <select
              data-testid="style-alignment"
              value={style.alignment}
              onChange={(e) =>
                setStyle({ alignment: e.target.value as "left" | "center" | "right" })
              }
              style={{ display: "none" }}
            >
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </label>
          <div className="grid-2">
            <label>
              Fade in (ms)
              <input
                type="number"
                min={0}
                max={3000}
                step={50}
                data-testid="style-fade-in"
                value={style.fade_in_ms}
                onChange={(e) => setStyle({ fade_in_ms: Number(e.target.value) })}
              />
            </label>
            <label>
              Fade out (ms)
              <input
                type="number"
                min={0}
                max={3000}
                step={50}
                data-testid="style-fade-out"
                value={style.fade_out_ms}
                onChange={(e) => setStyle({ fade_out_ms: Number(e.target.value) })}
              />
            </label>
          </div>
        </div>

        <div className="section-title">Subtitles</div>
        <div className="section">
          <label className="inline-label">
            <input
              type="checkbox"
              data-testid="use-subs-toggle"
              checked={useSubs}
              onChange={(e) => setUseSubs(e.target.checked)}
            />
            Show & export subtitles
          </label>
          {subsStreaming && (
            <div className="section-hint" data-testid="subs-streaming-hint">
              Generating subtitles — {progressPhase === "transcribe" ? `${progressPercent}%` : "…"}.
              You can crop, edit style, or export at any time; subs appear as they finish.
            </div>
          )}
        </div>

        <div className="section-title">Watermark</div>
        <div className="section">
          <label className="inline-label">
            <input
              type="checkbox"
              data-testid="watermark-toggle"
              checked={watermark}
              onChange={(e) => setWatermark(e.target.checked)}
            />
            Keep Cut/Storm watermark on export
          </label>
        </div>
      </div>
    </div>
  );
}
