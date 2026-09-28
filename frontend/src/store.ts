import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { temporal } from "zundo";

export type Word = { start: number; end: number; text: string };

export type Segment = {
  start: number;
  end: number;
  text: string;
  words?: Word[];
};

export type DisplayMode = "phrase" | "word" | "karaoke";

export type Style = {
  font_family: string;
  font_size: number;
  bold: boolean;
  italic: boolean;
  uppercase: boolean;
  text_color: string;
  outline_color: string;
  outline_width: number;
  shadow_offset: number;
  shadow_color: string;
  bg_color: string;
  bg_opacity: number;
  bg_padding: number;
  bg_radius: number;
  alignment: "left" | "center" | "right";
  fade_in_ms: number;
  fade_out_ms: number;
  mode: DisplayMode;
  words_per_chunk: number;
  active_word_color: string;
};

export type Position = { x_pct: number; y_pct: number };
export type Size = { w_pct: number; h_pct: number };

export type ProgressPhase =
  | "idle"
  | "upload"
  | "download"
  | "transcribe"
  | "align"
  | "encode"
  | "done";

export type TrimConfig = {
  enabled: boolean;
  threshold_sec: number;
  padding_sec: number;
};

export type AspectPreset = "source" | "9:16" | "16:9" | "1:1" | "4:5";
export type CanvasMode = "preset" | "custom";
export type CropAnchor = "left" | "center" | "right" | "top" | "bottom";

/** Social target presets (e.g. Instagram Reels). A social preset is NOT a
 * Canvas preset — it drives/accepted a Canvas config (Reels → 9:16) but stays
 * a separate concept so the user can still tweak the canvas afterwards. */
export type SocialPreset = "none" | "instagram-reels";

export type CustomCrop = {
  x_pct: number;
  y_pct: number;
  w_pct: number;
  h_pct: number;
};

export type CanvasConfig = {
  mode: CanvasMode;
  preset: AspectPreset;
  crop_anchor: CropAnchor;
  custom: CustomCrop;
  bg_color: string;
};

/** Keep-range selected by the trim handles under the preview. out_sec=0 => "to end".
 * `loop` (Coub mode): when true and an extra audio track is loaded, the
 * [in_sec..out_sec] slice is repeated to cover the extra audio's full
 * duration in both preview and export. */
export type TrimRange = { in_sec: number; out_sec: number; loop: boolean };

export type Clip = {
  id: string;
  in_sec: number;
  out_sec: number;
};

/** Original + optional extra audio track mixed into export. */
export type AudioConfig = {
  sourceVolume: number;        // 0.0..2.0, default 1.0
  extraAudioId: string | null;
  extraAudioName: string | null;
  extraAudioDuration: number;
  extraVolume: number;         // 0.0..2.0, default 1.0
};

/** Which transcript drives the on-screen captions and the burned subtitles
 * at export. "source" = whisper on the original video; "extra" = whisper on
 * the uploaded extra audio (Coub mode). */
export type SubtitleTrack = "source" | "extra";

type State = {
  videoId: string | null;
  videoUrl: string | null;
  duration: number;
  videoW: number;
  videoH: number;
  /** Active transcript — alias of segmentsSource or segmentsExtra depending
   * on `subtitleTrack`. Kept on the top level so existing code that reads
   * `s.segments` still finds the right data without refactor. */
  segments: Segment[];
  /** Whisper-on-source-video transcript. Filled by the upload flow. */
  segmentsSource: Segment[];
  /** Whisper-on-extra-audio transcript. Filled by the explicit Generate-subs
   * button on the extra track. */
  segmentsExtra: Segment[];
  /** Which transcript is active in the editor (and used for export). */
  subtitleTrack: SubtitleTrack;
  /** True while transcribe-extra is streaming. Mirrors `subsStreaming` for
   * the extra-track path. */
  extraSubsStreaming: boolean;
  style: Style;
  position: Position;
  size: Size;
  busy: "idle" | "uploading" | "exporting";
  error: string | null;
  progressPhase: ProgressPhase;
  progressPercent: number;
  currentTime: number;
  videoEl: HTMLMediaElement | null;
  trim: TrimConfig;
  trimRange: TrimRange;
  clips: Clip[];
  activeClipId: string | null;
  audio: AudioConfig;
  canvas: CanvasConfig;
  /** Social target the user is aiming at (Instagram Reels / none). Persisted. */
  socialPreset: SocialPreset;
  /** Instagram Reels UI safe-area guide toggle — a preview-only overlay.
   * Never affects crop, canvas config or export. The overlay only renders
   * while `socialPreset === "instagram-reels"`, so the Instagram-specific
   * guide can never stay active for None/other targets. */
  reelsGuide: boolean;
  isAudioOnly: boolean;
  /** Upload-screen toggle: generate subtitles via whisper after upload. Persisted. */
  generateSubs: boolean;
  /** Editor toggle: include subtitles in preview & export. Persisted. Off hides overlay. */
  useSubs: boolean;
  /** Editor toggle: burn the Cut/Storm watermark into the exported video. */
  watermark: boolean;
  /** True while background transcription is running (after upload, before done). */
  subsStreaming: boolean;
  /** Persisted across reloads so we can reconnect to the progress WS for an
   * in-flight whisper run. Cleared on reset / replace. */
  jobId: string | null;
};

type Actions = {
  setUploaded: (r: {
    video_id: string;
    duration: number;
    width: number;
    height: number;
    segments: Segment[];
    url: string;
    is_audio_only?: boolean;
  }) => void;
  loadProject: (r: {
    video_id: string;
    duration: number;
    width: number;
    height: number;
    segments: Segment[];
    url: string;
    is_audio_only?: boolean;
    project?: {
      style?: Style;
      position?: Position;
      size?: Size;
      canvas?: CanvasConfig;
      trim_range?: TrimRange;
      audio?: { source_volume: number; extra_audio_id: string | null; extra_volume: number };
      use_subs?: boolean;
      display_mode?: DisplayMode;
      extra_segments?: Segment[];
      subtitle_track?: SubtitleTrack;
      social_preset?: SocialPreset;
    } | null;
  }) => void;
  setLoop: (v: boolean) => void;
  setSubtitleTrack: (track: SubtitleTrack) => void;
  setExtraSegments: (segs: Segment[]) => void;
  setExtraSubsStreaming: (v: boolean) => void;
  appendExtraSegment: (seg: Segment, index: number) => void;
  mergeExtraSegments: (segs: Segment[]) => void;
  setStyle: (patch: Partial<Style>) => void;
  setPosition: (p: Position) => void;
  setSize: (s: Size) => void;
  updateSegment: (i: number, patch: Partial<Segment>) => void;
  deleteSegment: (i: number) => void;
  setBusy: (b: State["busy"]) => void;
  setError: (msg: string | null) => void;
  setProgress: (phase: ProgressPhase, percent: number) => void;
  setCurrentTime: (t: number) => void;
  setVideoEl: (el: HTMLMediaElement | null) => void;
  setTrim: (patch: Partial<TrimConfig>) => void;
  setTrimRange: (patch: Partial<TrimRange>) => void;
  addClip: () => void;
  updateClip: (id: string, patch: Partial<Clip>) => void;
  removeClip: (id: string) => void;
  selectClip: (id: string) => void;
  setAudio: (patch: Partial<AudioConfig>) => void;
  setCanvas: (patch: Partial<CanvasConfig>) => void;
  setCustomCrop: (patch: Partial<CustomCrop>) => void;
  setSocialPreset: (preset: SocialPreset) => void;
  setReelsGuide: (v: boolean) => void;
  setGenerateSubs: (v: boolean) => void;
  setUseSubs: (v: boolean) => void;
  setWatermark: (v: boolean) => void;
  setSubsStreaming: (v: boolean) => void;
  setJobId: (id: string | null) => void;
  mergeSegments: (segs: Segment[]) => void;
  appendSegment: (seg: Segment, index: number) => void;
  newProject: () => Promise<void>;
  playPause: () => void;
  nudge: (deltaSec: number) => void;
  splitAtCurrent: () => void;
  deleteCurrent: () => void;
  reset: () => void;
};

export const defaultStyle: Style = {
  font_family: "Anton",
  font_size: 48,
  bold: false,
  italic: false,
  uppercase: false,
  text_color: "#FFFFFF",
  outline_color: "#000000",
  outline_width: 2,
  shadow_offset: 0,
  shadow_color: "#000000",
  bg_color: "#000000",
  bg_opacity: 0,
  bg_padding: 8,
  bg_radius: 0,
  alignment: "center",
  fade_in_ms: 0,
  fade_out_ms: 0,
  mode: "karaoke",
  words_per_chunk: 4,
  active_word_color: "#FFD400",
};

export const useStore = create<State & Actions>()(
  temporal(
    persist(
      (set) => ({
      videoId: null,
      videoUrl: null,
      duration: 0,
      videoW: 0,
      videoH: 0,
      segments: [],
      segmentsSource: [],
      segmentsExtra: [],
      subtitleTrack: "source" as SubtitleTrack,
      extraSubsStreaming: false,
      style: { ...defaultStyle },
      position: { x_pct: 10, y_pct: 80 },
      size: { w_pct: 80, h_pct: 15 },
      busy: "idle",
      error: null,
      progressPhase: "idle",
      progressPercent: 0,
      currentTime: 0,
      videoEl: null,
      trim: { enabled: false, threshold_sec: 0.4, padding_sec: 0.08 },
      trimRange: { in_sec: 0, out_sec: 0, loop: false },
      clips: [],
      activeClipId: null,
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
      reelsGuide: false,
      isAudioOnly: false,
      generateSubs: true,
      useSubs: true,
      watermark: true,
      subsStreaming: false,
      jobId: null,
      setUploaded: (r) =>
        set((s) => {
          const isAudio = !!r.is_audio_only || (r.width === 0 && r.height === 0);
          return {
            videoId: r.video_id,
            videoUrl: r.url,
            duration: r.duration,
            videoW: r.width,
            videoH: r.height,
            segments: r.segments,  // may be empty initially — bg stream fills via appendSegment
            segmentsSource: r.segments,
            segmentsExtra: [],
            subtitleTrack: "source" as SubtitleTrack,
            extraSubsStreaming: false,
            busy: "idle",
            error: null,
            isAudioOnly: isAudio,
            // A new upload represents a fresh edit: reset trim range and extra audio.
            trimRange: { in_sec: 0, out_sec: 0, loop: false },
	    clips: [],
            activeClipId: null,
            audio: {
              sourceVolume: 1.0,
              extraAudioId: null,
              extraAudioName: null,
              extraAudioDuration: 0,
              extraVolume: 1.0,
            },
            canvas: isAudio && s.canvas.preset === "source"
              ? { ...s.canvas, preset: "9:16", bg_color: s.canvas.bg_color === "#000000" ? "#00B140" : s.canvas.bg_color }
              : s.canvas,
            // A fresh upload starts a new edit — don't carry a social target
            // from the previous project.
            socialPreset: "none" as SocialPreset,
          };
        }),
      loadProject: (r) => set((s) => {
        const isAudio = !!r.is_audio_only || (r.width === 0 && r.height === 0);
        const p = r.project ?? null;
        const extraSegs = p?.extra_segments ?? [];
        const track: SubtitleTrack = p?.subtitle_track ?? "source";
        const activeSegs = track === "extra" ? extraSegs : r.segments;
        return {
          videoId: r.video_id,
          videoUrl: r.url,
          duration: r.duration,
          videoW: r.width,
          videoH: r.height,
          segments: activeSegs,
          segmentsSource: r.segments,
          segmentsExtra: extraSegs,
          subtitleTrack: track,
          extraSubsStreaming: false,
          busy: "idle",
          error: null,
          isAudioOnly: isAudio,
          // Honour saved project state when present; fall back to current
          // store defaults otherwise. Unlike setUploaded, do NOT reset trim
          // and audio — that's the whole point of the history restore.
          style: p?.style ?? s.style,
          position: p?.position ?? s.position,
          size: p?.size ?? s.size,
          canvas: p?.canvas ?? s.canvas,
          // Restore the saved social target; projects predating this field fall
          // back to the current value (defaults to "none").
          socialPreset: p?.social_preset ?? s.socialPreset,
          trimRange: p?.trim_range
            ? { in_sec: p.trim_range.in_sec, out_sec: p.trim_range.out_sec, loop: !!p.trim_range.loop }
            : { in_sec: 0, out_sec: 0, loop: false },
          audio: p?.audio
            ? {
                sourceVolume: p.audio.source_volume,
                extraAudioId: p.audio.extra_audio_id,
                extraAudioName: null,
                extraAudioDuration: 0,
                extraVolume: p.audio.extra_volume,
              }
            : {
                sourceVolume: 1.0,
                extraAudioId: null,
                extraAudioName: null,
                extraAudioDuration: 0,
                extraVolume: 1.0,
              },
          useSubs: p?.use_subs ?? s.useSubs,
        };
      }),
      setStyle: (patch) => set((s) => ({ style: { ...s.style, ...patch } })),
      setPosition: (p) => set({ position: p }),
      setSize: (sz) => set({ size: sz }),
      setLoop: (v) => set((s) => ({ trimRange: { ...s.trimRange, loop: v } })),
      setSubtitleTrack: (track) => set((s) => ({
        subtitleTrack: track,
        // Mirror the active store-level alias so existing readers (overlay,
        // segment list) update without further plumbing.
        segments: track === "extra" ? s.segmentsExtra : s.segmentsSource,
      })),
      setExtraSegments: (segs) => set((s) => ({
        segmentsExtra: segs,
        segments: s.subtitleTrack === "extra" ? segs : s.segments,
      })),
      setExtraSubsStreaming: (v) => set({ extraSubsStreaming: v }),
      appendExtraSegment: (seg, index) => set((s) => {
        const next = [...s.segmentsExtra];
        next[index] = seg;
        for (let i = 0; i < next.length; i++) {
          if (next[i] === undefined) {
            next[i] = { start: 0, end: 0, text: "…", words: [] };
          }
        }
        return s.subtitleTrack === "extra"
          ? { segments: next, segmentsExtra: next }
          : { segmentsExtra: next };
      }),
      mergeExtraSegments: (incoming) => set((s) => {
        const next = [...s.segmentsExtra];
        incoming.forEach((seg, i) => {
          if (!next[i] || next[i].text !== seg.text || next[i].start !== seg.start) {
            next[i] = seg;
          }
        });
        return s.subtitleTrack === "extra"
          ? { segments: next, segmentsExtra: next }
          : { segmentsExtra: next };
      }),
      updateSegment: (i, patch) =>
        set((s) => {
          const next = s.segments.map((seg, idx) => {
            if (idx !== i) return seg;
            const merged: Segment = { ...seg, ...patch };
            if (patch.text !== undefined && patch.text !== seg.text) {
              merged.words = undefined;
            }
            return merged;
          });
          return s.subtitleTrack === "extra"
            ? { segments: next, segmentsExtra: next }
            : { segments: next, segmentsSource: next };
        }),
      deleteSegment: (i) =>
        set((s) => {
          const next = s.segments.filter((_, idx) => idx !== i);
          return s.subtitleTrack === "extra"
            ? { segments: next, segmentsExtra: next }
            : { segments: next, segmentsSource: next };
        }),
      setBusy: (b) => set({ busy: b }),
      setError: (msg) => set({ error: msg }),
      setProgress: (phase, percent) => set({ progressPhase: phase, progressPercent: percent }),
      setCurrentTime: (t) => set({ currentTime: t }),
      setVideoEl: (el) => set({ videoEl: el }),
      setTrim: (patch) => set((s) => ({ trim: { ...s.trim, ...patch } })),
            setTrimRange: (patch) => set((s) => {
        const dur = s.duration || 0;
        const next: TrimRange = { ...s.trimRange, ...patch };

        // Clamp to [0, duration]. out_sec=0 stays as sentinel for "to end".
        next.in_sec = Math.max(0, Math.min(next.in_sec, Math.max(0, dur - 0.1)));

        if (next.out_sec > 0) {
          next.out_sec = Math.max(
            next.in_sec + 0.1,
            Math.min(next.out_sec, dur)
          );
        }

        // Keep the selected clip synchronized with the active trim range.
        if (s.activeClipId) {
          const clips = s.clips.map((clip) =>
            clip.id === s.activeClipId
              ? {
                  ...clip,
                  in_sec: next.in_sec,
                  out_sec: next.out_sec,
                }
              : clip
          );

          return {
            trimRange: next,
            clips,
          };
        }

        return { trimRange: next };
      }),

      addClip: () => set((s) => {
        const inSec = s.trimRange.in_sec;
        const outSec = s.trimRange.out_sec > 0
          ? s.trimRange.out_sec
          : s.duration;

        if (outSec <= inSec) {
          return {};
        }

        const clip: Clip = {
          id: `clip-${Date.now()}-${s.clips.length}`,
          in_sec: inSec,
          out_sec: outSec,
        };

        return {
          clips: [...s.clips, clip],
          activeClipId: clip.id,
        };
      }),

      updateClip: (id, patch) => set((s) => {
        const clips = s.clips.map((clip) =>
          clip.id === id
            ? { ...clip, ...patch }
            : clip
        );

        const updated = clips.find((clip) => clip.id === id);

        if (!updated) {
          return { clips };
        }

        if (s.activeClipId === id) {
          return {
            clips,
            trimRange: {
              ...s.trimRange,
              in_sec: updated.in_sec,
              out_sec: updated.out_sec,
            },
          };
        }

        return { clips };
      }),

      removeClip: (id) => set((s) => {
        const clips = s.clips.filter((clip) => clip.id !== id);

        if (s.activeClipId !== id) {
          return { clips };
        }

        if (clips.length === 0) {
          return {
            clips,
            activeClipId: null,
            trimRange: {
              in_sec: 0,
              out_sec: 0,
              loop: false,
            },
          };
        }

        const nextClip = clips[clips.length - 1];

        return {
          clips,
          activeClipId: nextClip.id,
          trimRange: {
            ...s.trimRange,
            in_sec: nextClip.in_sec,
            out_sec: nextClip.out_sec,
          },
        };
      }),

      selectClip: (id) => set((s) => {
        const clip = s.clips.find((c) => c.id === id);

        if (!clip) {
          return {};
        }

        return {
          activeClipId: id,
          trimRange: {
            ...s.trimRange,
            in_sec: clip.in_sec,
            out_sec: clip.out_sec,
          },
        };
      }),
      setAudio: (patch) => set((s) => ({ audio: { ...s.audio, ...patch } })),
      setCanvas: (patch) => set((s) => {
        // Selecting a different canvas mode/preset is a manual canvas change:
        // the output is no longer the social preset's target frame, so drop the
        // social target back to "none". Anchor / bg-color tweaks are NOT canvas
        // changes and keep the social preset intact.
        const manualCanvasChange =
          (patch.preset !== undefined && patch.preset !== s.canvas.preset) ||
          (patch.mode !== undefined && patch.mode !== s.canvas.mode);
        return {
          canvas: { ...s.canvas, ...patch },
          ...(manualCanvasChange ? { socialPreset: "none" as SocialPreset } : {}),
        };
      }),
      setSocialPreset: (preset) => set((s) =>
        // Applying Instagram Reels snaps the Canvas PRESET to 9:16, atomically
        // in a single set — so the manual-canvas-change reset above never fires
        // for this operation and clobber the preset we just picked.
        // `canvas.mode` is deliberately left untouched: forcing it back to
        // "preset" would unmount CropEditor, throwing away an in-progress
        // custom crop / reframe (the interactive frame on the preview).
        preset === "instagram-reels"
          ? {
              socialPreset: preset,
              canvas: { ...s.canvas, preset: "9:16" as AspectPreset },
            }
          : { socialPreset: preset },
      ),
      // Preview-only viewing aid (Reels UI safe-area guide). Deliberately NOT
      // part of the undo history (zundo partialize) — it changes nothing in
      // the exported video.
      setReelsGuide: (v) => set({ reelsGuide: v }),
      setGenerateSubs: (v) => set({ generateSubs: v }),
      setUseSubs: (v) => set({ useSubs: v }),
      setWatermark: (v) => set({ watermark: v }),
      setSubsStreaming: (v) => set({ subsStreaming: v }),
      setJobId: (id) => set({ jobId: id }),
      mergeSegments: (serverSegs) => set((s) => {
        // Merge server snapshot into the SOURCE transcript without truncating.
        // Source segments are filled by the upload-time whisper pass; the
        // extra-track transcript has its own merge path via setExtraSegments.
        const next = [...s.segmentsSource];
        serverSegs.forEach((seg, i) => {
          if (!next[i] || (next[i] && (next[i].text !== seg.text || next[i].start !== seg.start))) {
            next[i] = seg;
          }
        });
        return s.subtitleTrack === "source"
          ? { segments: next, segmentsSource: next }
          : { segmentsSource: next };
      }),
      newProject: async () => {
        // Best-effort server-side cancellation of any in-flight whisper for
        // the current video, then reset the frontend. We never block the
        // reset on the network — the user expects "New project" to be instant.
        const s = useStore.getState();
        if (s.videoId && s.subsStreaming) {
          const { cancelTranscribe } = await import("./api");
          void cancelTranscribe(s.videoId);
        }
        useStore.getState().reset();
      },
      appendSegment: (seg, index) => set((s) => {
        const next = [...s.segmentsSource];
        next[index] = seg;
        // If the backend emitted indices out of order somehow, fill any gaps
        // with placeholders (extremely unlikely; defensive only).
        for (let i = 0; i < next.length; i++) {
          if (next[i] === undefined) {
            next[i] = { start: 0, end: 0, text: "…", words: [] };
          }
        }
        return s.subtitleTrack === "source"
          ? { segments: next, segmentsSource: next }
          : { segmentsSource: next };
      }),
      setCustomCrop: (patch) => set((s) => {
        const next = { ...s.canvas.custom, ...patch };
        // Clamp so x+w <= 100, y+h <= 100 — UI may race faster than backend validator.
        if (next.x_pct + next.w_pct > 100) next.w_pct = Math.max(5, 100 - next.x_pct);
        if (next.y_pct + next.h_pct > 100) next.h_pct = Math.max(5, 100 - next.y_pct);
        if (next.w_pct < 5) next.w_pct = 5;
        if (next.h_pct < 5) next.h_pct = 5;
        if (next.x_pct < 0) next.x_pct = 0;
        if (next.y_pct < 0) next.y_pct = 0;
        if (next.x_pct > 95) next.x_pct = 95;
        if (next.y_pct > 95) next.y_pct = 95;
        // A custom crop is a manual canvas change — the social target no longer
        // describes the output frame.
        return { canvas: { ...s.canvas, custom: next }, socialPreset: "none" as SocialPreset };
      }),
      playPause: () => {
        const el = useStore.getState().videoEl;
        if (!el) return;
        if (el.paused) el.play().catch(() => {});
        else el.pause();
      },
      nudge: (deltaSec) => {
        const el = useStore.getState().videoEl;
        if (!el) return;
        const next = Math.max(0, Math.min(el.duration || 0, el.currentTime + deltaSec));
        el.currentTime = next;
      },
      splitAtCurrent: () =>
        set((s) => {
          const t = s.currentTime;
          const idx = s.segments.findIndex((seg) => t > seg.start && t < seg.end);
          if (idx < 0) return {};
          const seg = s.segments[idx];
          const leftWords = seg.words?.filter((w) => w.end <= t) ?? [];
          const rightWords = seg.words?.filter((w) => w.start >= t) ?? [];
          const leftText = leftWords.length
            ? leftWords.map((w) => w.text).join(" ")
            : seg.text;
          const rightText = rightWords.length
            ? rightWords.map((w) => w.text).join(" ")
            : seg.text;
          const left = { ...seg, end: t, text: leftText, words: leftWords.length ? leftWords : undefined };
          const right = { ...seg, start: t, text: rightText, words: rightWords.length ? rightWords : undefined };
          const next = [...s.segments.slice(0, idx), left, right, ...s.segments.slice(idx + 1)];
          return s.subtitleTrack === "extra"
            ? { segments: next, segmentsExtra: next }
            : { segments: next, segmentsSource: next };
        }),
      deleteCurrent: () =>
        set((s) => {
          const t = s.currentTime;
          const idx = s.segments.findIndex((seg) => t >= seg.start && t <= seg.end);
          if (idx < 0) return {};
          const next = s.segments.filter((_, i) => i !== idx);
          return s.subtitleTrack === "extra"
            ? { segments: next, segmentsExtra: next }
            : { segments: next, segmentsSource: next };
        }),
      reset: () =>
        set((s) => ({
          videoId: null,
          videoUrl: null,
          duration: 0,
          videoW: 0,
          videoH: 0,
          segments: [],
          segmentsSource: [],
          segmentsExtra: [],
          subtitleTrack: "source" as SubtitleTrack,
          extraSubsStreaming: false,
          busy: "idle",
          error: null,
          progressPhase: "idle",
          progressPercent: 0,
          currentTime: 0,
          isAudioOnly: false,
          subsStreaming: false,
          jobId: null,
          watermark: true,
          trimRange: { in_sec: 0, out_sec: 0, loop: false },
          socialPreset: "none" as SocialPreset,
          reelsGuide: false,
          clips: [],
          activeClipId: null,
          audio: {
            sourceVolume: 1.0,
            extraAudioId: null,
            extraAudioName: null,
            extraAudioDuration: 0,
            extraVolume: 1.0,
          },
          // A new project always starts from the source frame: return the Canvas
          // preset to "source". `canvas.mode` and the remaining canvas fields
          // (crop_anchor / custom / bg_color) are intentionally preserved so a
          // reset never silently flips an in-progress custom crop.
          canvas: { ...s.canvas, preset: "source" as AspectPreset },
        })),
    }),
    {
      name: "cutstorm-state",
      storage: createJSONStorage(() => localStorage),
      // Only persist the project state. Skip transient runtime state
      // (busy, error, progress, currentTime) so a refresh doesn't restore
      // a half-finished upload spinner or stale error toast.
      partialize: (s) => ({
        videoId: s.videoId,
        videoUrl: s.videoUrl,
        duration: s.duration,
        videoW: s.videoW,
        videoH: s.videoH,
        segments: s.segments,
        segmentsSource: s.segmentsSource,
        segmentsExtra: s.segmentsExtra,
        subtitleTrack: s.subtitleTrack,
        style: s.style,
        position: s.position,
        size: s.size,
        trim: s.trim,
        trimRange: s.trimRange,
	clips: s.clips,
	activeClipId: s.activeClipId,
	audio: s.audio,
        canvas: s.canvas,
        socialPreset: s.socialPreset,
        reelsGuide: s.reelsGuide,
        isAudioOnly: s.isAudioOnly,
        generateSubs: s.generateSubs,
        useSubs: s.useSubs,
        watermark: s.watermark,
        subsStreaming: s.subsStreaming,
        jobId: s.jobId,
      }),
        version: 10,
        // Historical fields migrate forward:
        //   v1→v2: `canvas` gained mode/crop_anchor/custom (Feature 1).
        //   v2→v3: `trimRange` added (Feature Trim in/out).
        //   v3→v4: `audio` added (Feature Volume + extra track).
        // zustand's default merge is shallow — persisted fields REPLACE the
        // defaults — so missing keys must be filled explicitly to avoid
        // undefined reads in the UI.
        migrate: (persisted: unknown, version: number) => {
          if (!persisted || typeof persisted !== "object") return persisted;
          const p = persisted as Record<string, unknown>;
          if (version < 2 && p.canvas && typeof p.canvas === "object") {
            p.canvas = {
              mode: "preset",
              crop_anchor: "center",
              custom: { x_pct: 10, y_pct: 10, w_pct: 80, h_pct: 80 },
              ...(p.canvas as Record<string, unknown>),
            };
          }
          if (version < 3) {
            p.trimRange = p.trimRange ?? { in_sec: 0, out_sec: 0 };
          }
          if (version < 4) {
            p.audio = p.audio ?? {
              sourceVolume: 1.0,
              extraAudioId: null,
              extraAudioName: null,
              extraAudioDuration: 0,
              extraVolume: 1.0,
            };
          }
          if (version < 5) {
            // v4→v5: jobId + subsStreaming are now persisted so a page reload
            // mid-transcribe can reconnect to the progress WS.
            p.jobId = p.jobId ?? null;
            p.subsStreaming = p.subsStreaming ?? false;
          }
          if (version < 6) {
            // v5→v6: Style gained an `uppercase` toggle (renders captions
            // in ALL CAPS regardless of the chosen font).
            if (p.style && typeof p.style === "object") {
              (p.style as Record<string, unknown>).uppercase =
                (p.style as Record<string, unknown>).uppercase ?? false;
            }
          }
          if (version < 7) {
            // v6→v7: watermark toggle (on by default for new projects).
            p.watermark = p.watermark ?? true;
          }
          if (version < 8) {
            // v7→v8: Coub-mode fields.
            //   trimRange.loop : new boolean (default false).
            //   segmentsSource : copy of legacy `segments` (the only track
            //                    that existed before extra-track transcribe).
            //   segmentsExtra  : empty list — extra subs are only filled by
            //                    explicit user action.
            //   subtitleTrack  : "source" — preserves prior behaviour.
            const tr = (p.trimRange as Record<string, unknown> | undefined) ?? {};
            p.trimRange = {
              in_sec: typeof tr.in_sec === "number" ? tr.in_sec : 0,
              out_sec: typeof tr.out_sec === "number" ? tr.out_sec : 0,
              loop: typeof tr.loop === "boolean" ? tr.loop : false,
            };
            const segs = Array.isArray(p.segments) ? p.segments : [];
            p.segmentsSource = (p.segmentsSource as unknown) ?? segs;
            p.segmentsExtra = (p.segmentsExtra as unknown) ?? [];
            p.subtitleTrack = (p.subtitleTrack as unknown) ?? "source";
          }
          if (version < 9) {
            // v8→v9: multiple manual clips.
            p.clips = Array.isArray(p.clips) ? p.clips : [];
            p.activeClipId =
              typeof p.activeClipId === "string" ? p.activeClipId : null;
          }

          if (version < 10) {
            // v9→v10: Social Preset selector (Instagram Reels → Canvas 9:16) +
            // Reels UI safe-area guide toggle (preview-only overlay).
            // Pre-existing projects have no social target → default "none",
            // and the guide stays off. Never overwrite an existing value.
            p.socialPreset = p.socialPreset ?? "none";
            p.reelsGuide = p.reelsGuide ?? false;
          }
          return p;
        },
      },
    ),
    {
      partialize: (s) => ({
        segments: s.segments,
        segmentsSource: s.segmentsSource,
        segmentsExtra: s.segmentsExtra,
        subtitleTrack: s.subtitleTrack,
        style: s.style,
        position: s.position,
        size: s.size,
        trim: s.trim,
        trimRange: s.trimRange,
        clips: s.clips,
        activeClipId: s.activeClipId,
        audio: s.audio,
        canvas: s.canvas,
      }),
      limit: 50,
    },
  ),
);
