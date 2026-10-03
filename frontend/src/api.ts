import type {
  AudioConfig,
  CanvasConfig,
  DisplayMode,
  Position,
  Segment,
  Size,
  SocialPreset,
  Style,
  TrimRange,
} from "./store";

export type ProjectStatePayload = {
  style?: Style;
  position?: Position;
  size?: Size;
  canvas?: CanvasConfig;
  trim_range?: TrimRange;
  audio?: { source_volume: number; extra_audio_id: string | null; extra_volume: number };
  use_subs?: boolean;
  display_mode?: DisplayMode;
  updated_at?: number;
  extra_segments?: Segment[];
  subtitle_track?: "source" | "extra";
  social_preset?: SocialPreset;
};

const API_BASE = "";

export type TranscribeStatus = "pending" | "done" | "cancelled" | "error" | "stale";

export type TranscribeResult = {
  video_id: string;
  duration: number;
  width: number;
  height: number;
  language?: string | null;
  segments: Segment[];
  /** Original upload filename (as sent by the backend). Used to derive the
   * SRT download name. May be null for legacy/URL-imported entries. */
  original_filename?: string | null;
  is_audio_only?: boolean;
  status?: TranscribeStatus | null;
  percent?: number | null;
  job_id?: string | null;
  error?: string | null;
  project?: ProjectStatePayload | null;
};

export async function uploadVideo(
  file: File,
  opts: {
    language?: string;
    model?: string;
    generateSubs?: boolean;
    jobId?: string;
    signal?: AbortSignal;
    onUploadProgress?: (pct: number) => void;
  } = {},
): Promise<TranscribeResult> {
  const fd = new FormData();
  fd.append("file", file);
  if (opts.language) fd.append("language", opts.language);
  if (opts.model) fd.append("model", opts.model);
  fd.append("generate_subs", opts.generateSubs === false ? "false" : "true");
  const url = opts.jobId
    ? `${API_BASE}/api/transcribe?job_id=${encodeURIComponent(opts.jobId)}`
    : `${API_BASE}/api/transcribe`;

  return new Promise<TranscribeResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      opts.onUploadProgress?.(pct);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as TranscribeResult);
      } else {
        reject(new Error(`upload failed: ${xhr.status} ${xhr.responseText ?? ""}`));
      }
    };
    xhr.onerror = () => reject(new Error("upload failed: network error"));
    xhr.onabort = () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        xhr.abort();
        return;
      }
      opts.signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(fd);
  });
}



export function videoUrl(videoId: string): string {
  return `${API_BASE}/api/video/${videoId}`;
}

export type ExportFormat = "mp4" | "gif" | "mkv";
export type GifQuality = "low" | "medium" | "high";

export type ExportResponse = {
  video_id: string;
  output_path: string;
  output_format?: ExportFormat;
  clip_index?: number | null;
  original_duration?: number | null;
  output_duration?: number | null;
  cuts?: [number, number][] | null;
};

/**
 * Export cancellation plumbing.
 *
 * `cancelExport(jobId)` POSTs to the backend cancel endpoint (which kills the
 * ffmpeg/Chromium child) and then aborts the in-flight `POST /api/export`
 * fetch, so the UI unsticks even if the server takes a moment to unwind.
 * The abort signal is registered per job id by `registerExportAbort`.
 */
const _exportAborts = new Map<string, AbortController>();

/** Create + register the AbortSignal for an export run. Returns the signal to
 * pass to `exportVideo`. Call `clearExportAbort` when the request settles. */
export function registerExportAbort(jobId: string): AbortSignal {
  // Replace any stale controller for the same id (shouldn't happen — ids are
  // unique per run — but keeps the map from growing if a run never settles).
  _exportAborts.get(jobId)?.abort();
  const ctrl = new AbortController();
  _exportAborts.set(jobId, ctrl);
  return ctrl.signal;
}

export function clearExportAbort(jobId: string): void {
  _exportAborts.delete(jobId);
}

/** True for both cancellation flavours: a local abort (AbortError) or the
 * backend's 499 "export cancelled" response. */
export function isExportCancel(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.name === "ExportCancelledError";
}

export async function exportVideo(args: {
  videoId: string;
  segments: Segment[];
  style: Style;
  position: Position;
  size: Size;
  canvas?: CanvasConfig;
  jobId?: string;
  trimSilences?: boolean;
  silenceThresholdSec?: number;
  silencePaddingSec?: number;
  trim?: TrimRange;
  audio?: AudioConfig;
  format?: ExportFormat;
  gifQuality?: GifQuality;
  watermark?: boolean;
  clipIndex?: number;
  subtitleTrack?: "source" | "extra";
  resolution?: string;
  fps?: number;
  optimizeForInstagram?: boolean;
  /** Aborted by `cancelExport` when the user presses Stop. */
  signal?: AbortSignal;
}): Promise<ExportResponse> {
  const url = args.jobId
    ? `${API_BASE}/api/export?job_id=${encodeURIComponent(args.jobId)}`
    : `${API_BASE}/api/export`;
  const trim = args.trim ?? { in_sec: 0, out_sec: 0, loop: false };
  const audio = args.audio;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      video_id: args.videoId,
      segments: args.segments,
      style: args.style,
      position: args.position,
      size: args.size,
      trim_silences: args.trimSilences ?? false,
      silence_threshold_sec: args.silenceThresholdSec ?? 0.4,
      silence_padding_sec: args.silencePaddingSec ?? 0.08,
      canvas: args.canvas ?? { preset: "source", bg_color: "#000000" },
      trim: {
        in_sec: trim.in_sec,
        out_sec: trim.out_sec,
        loop: !!(trim as TrimRange).loop,
      },
      audio: {
        source_volume: audio?.sourceVolume ?? 1.0,
        extra_audio_id: audio?.extraAudioId ?? null,
        extra_volume: audio?.extraVolume ?? 1.0,
      },
      format: args.format ?? "mp4",
      gif_quality: args.gifQuality ?? "medium",
      watermark: args.watermark !== false,
      clip_index: args.clipIndex ?? null,
      subtitle_track: args.subtitleTrack ?? "source",
      resolution: args.resolution ?? "1080p",
      fps: args.fps ?? 30,
      optimize_for_instagram: args.optimizeForInstagram ?? true,
    }),
    signal: args.signal,
  });
  if (res.status === 499) {
    // Backend reports a user cancellation, not a failure.
    const err = new Error("export cancelled");
    err.name = "ExportCancelledError";
    throw err;
  }
  if (!res.ok) throw new Error(`export failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function cancelExport(jobId: string): Promise<boolean> {
  let cancelled = false;
  try {
    const res = await fetch(
      `${API_BASE}/api/export/${encodeURIComponent(jobId)}/cancel`,
      { method: "POST", signal: AbortSignal.timeout(2000) },
    );
    if (res.ok) {
      const body = await res.json();
      cancelled = !!body.cancelled;
    }
  } catch {
    // Timeout or network — the abort below still unsticks the UI.
    cancelled = false;
  }
  // Unblock the waiting export request. The POST already killed the worker,
  // so its response (a 499) is redundant and the abort keeps the Export
  // button from staying disabled while the thread unwinds.
  _exportAborts.get(jobId)?.abort();
  _exportAborts.delete(jobId);
  return cancelled;
}

export type ExtraAudioResult = {
  extra_audio_id: string;
  duration: number;
  name: string;
};

export async function uploadExtraAudio(file: File): Promise<ExtraAudioResult> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`${API_BASE}/api/extra-audio`, { method: "POST", body: fd });
  if (!res.ok) {
    throw new Error(`extra-audio upload failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export type TranscribeExtraResult = {
  extra_audio_id: string;
  duration: number;
  language: string | null;
  segments: Segment[];
};

export async function transcribeExtra(
  extraAudioId: string,
  opts: { language?: string; model?: string; jobId?: string } = {},
): Promise<TranscribeExtraResult> {
  const fd = new FormData();
  fd.append("extra_audio_id", extraAudioId);
  if (opts.language) fd.append("language", opts.language);
  if (opts.model) fd.append("model", opts.model);
  const url = opts.jobId
    ? `${API_BASE}/api/transcribe-extra?job_id=${encodeURIComponent(opts.jobId)}`
    : `${API_BASE}/api/transcribe-extra`;
  const res = await fetch(url, { method: "POST", body: fd });
  if (!res.ok) {
    throw new Error(`transcribe-extra failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export function downloadUrl(
  videoId: string,
  format: ExportFormat = "mp4",
  clipIndex?: number,
): string {
  const params = new URLSearchParams({ format });

  if (clipIndex !== undefined) {
    params.set("clip_index", String(clipIndex));
  }

  return `${API_BASE}/api/download/${videoId}?${params.toString()}`;
}

export type TranscriptSummary = {
  video_id: string;
  original_filename: string | null;
  language: string | null;
  model: string | null;
  duration: number;
  width: number;
  height: number;
  segments_count: number;
  updated_at: number;
};

export async function listTranscripts(): Promise<TranscriptSummary[]> {
  const res = await fetch(`${API_BASE}/api/transcripts`);
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  return res.json();
}

export async function getTranscript(videoId: string): Promise<TranscribeResult> {
  const res = await fetch(`${API_BASE}/api/transcripts/${videoId}`);
  if (!res.ok) throw new Error(`get failed: ${res.status}`);
  return res.json();
}

export async function updateTranscript(
  videoId: string,
  segments: Segment[],
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/transcripts/${videoId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ segments }),
  });
  if (!res.ok) throw new Error(`update failed: ${res.status}`);
}

export async function saveProjectState(
  videoId: string,
  project: ProjectStatePayload,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/transcripts/${videoId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project }),
  });
  if (!res.ok) throw new Error(`save project failed: ${res.status}`);
}

export type StorageInfo = {
  uploads_bytes: number;
  outputs_bytes: number;
  models_bytes: number;
  total_bytes: number;
  projects: number;
};

export async function getStorageInfo(): Promise<StorageInfo> {
  const res = await fetch(`${API_BASE}/api/storage`);
  if (!res.ok) throw new Error(`storage fetch failed: ${res.status}`);
  return res.json();
}

export async function sweepOrphansNow(): Promise<{
  thumbs: number;
  outputs: number;
  ass: number;
  url_cache: number;
  extras: number;
  stale_marked: number;
}> {
  const res = await fetch(`${API_BASE}/api/storage/sweep-now`, { method: "POST" });
  if (!res.ok) throw new Error(`sweep failed: ${res.status}`);
  return res.json();
}

export async function deleteTranscript(
  videoId: string,
  dropVideo = false,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/transcripts/${videoId}?drop_video=${dropVideo}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(`delete failed: ${res.status}`);
}



export async function cancelTranscribe(videoId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${API_BASE}/api/transcribe/${videoId}/cancel`,
      { method: "POST", signal: AbortSignal.timeout(2000) },
    );
    if (!res.ok) return false;
    const body = await res.json();
    return !!body.cancelled;
  } catch {
    // Timeout or network — fall back to client-only reset.
    return false;
  }
}

export async function cancelTranscribeExtra(extraAudioId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${API_BASE}/api/transcribe-extra/${encodeURIComponent(extraAudioId)}/cancel`,
      { method: "POST", signal: AbortSignal.timeout(2000) },
    );
    if (!res.ok) return false;
    const body = await res.json();
    return !!body.cancelled;
  } catch {
    return false;
  }
}
