import { useState } from "react";
import {
  clearExportAbort,
  downloadUrl,
  exportVideo,
  isExportCancel,
  registerExportAbort,
  type ExportFormat,
  type GifQuality,
} from "../api";
import { newJobId, openProgressWs } from "../progress";
import { useStore } from "../store";
import type { Clip } from "../store";

/**
 * Check if a clip object has the required properties.
 */
function isValidClip(clip: unknown): clip is Clip {
  return (
    typeof clip === "object" &&
    clip !== null &&
    typeof (clip as Clip).id === "string" &&
    typeof (clip as Clip).in_sec === "number" &&
    Number.isFinite((clip as Clip).in_sec) &&
    typeof (clip as Clip).out_sec === "number" &&
    Number.isFinite((clip as Clip).out_sec)
  );
}

/**
 * Safely extract and validate trim values from a clip.
 * Falls back to video duration for out_sec if clip value is invalid or 0.
 * Ensures the returned object always has valid numeric in_sec/out_sec.
 */
function getValidatedClipTrim(clip: Clip, videoDuration: number): { in_sec: number; out_sec: number; loop: boolean } {
  const inSec = typeof clip.in_sec === "number" && Number.isFinite(clip.in_sec) ? clip.in_sec : 0;
  const outSec = typeof clip.out_sec === "number" && Number.isFinite(clip.out_sec) && clip.out_sec > 0
    ? clip.out_sec
    : videoDuration || 0;
  // Clamp in_sec to valid range
  const clampedInSec = Math.max(0, Math.min(inSec, Math.max(0, (videoDuration || 0) - 0.1)));
  // Clamp out_sec to valid range
  const clampedOutSec = outSec > 0
    ? Math.max(clampedInSec + 0.1, Math.min(outSec, videoDuration || 0))
    : videoDuration || 0;
  return {
    in_sec: clampedInSec,
    out_sec: clampedOutSec,
    loop: false,
  };
}

export type ExportResolution = "720p" | "1080p" | "4k";
export type ExportFps = 30 | 60;

export function ExportPanel() {
  const videoId = useStore((s) => s.videoId);
  const segments = useStore((s) => s.segments);
  const style = useStore((s) => s.style);
  const position = useStore((s) => s.position);
  const size = useStore((s) => s.size);
  const canvas = useStore((s) => s.canvas);
  const useSubs = useStore((s) => s.useSubs);
  const trim = useStore((s) => s.trim);
  const trimRange = useStore((s) => s.trimRange);
  const clips = useStore((s) => s.clips);
  const duration = useStore((s) => s.duration);
  const audio = useStore((s) => s.audio);
  const watermark = useStore((s) => s.watermark);
  const subtitleTrack = useStore((s) => s.subtitleTrack);
  const busy = useStore((s) => s.busy);
  const setBusy = useStore((s) => s.setBusy);
  const setError = useStore((s) => s.setError);
  const setProgress = useStore((s) => s.setProgress);
  const setExportJobId = useStore((s) => s.setExportJobId);
  const [format, setFormat] = useState<ExportFormat>("mp4");
  const [resolution, setResolution] = useState<ExportResolution>("1080p");
  const [fps, setFps] = useState<ExportFps>(60);
  const [optimizeForInstagram, setOptimizeForInstagram] = useState(true);
  const [gifQuality, setGifQuality] = useState<GifQuality>("medium");
  const [downloads, setDownloads] = useState<
    Array<{ clipIndex: number; url: string; format: ExportFormat }>
  >([]);

  async function onExport() {
    if (!videoId) return;
    setBusy("exporting");
    setError(null);
    setProgress("encode", 0);
    setDownloads([]);
    
    // Ensure clips is a valid array
    const validClips = Array.isArray(clips) ? clips.filter(isValidClip) : [];
    const clipsToExport = validClips.length > 0 ? validClips : [null];
    let cancelledByUser = false;
    try {
      for (let i = 0; i < clipsToExport.length; i += 1) {
        const clip = clipsToExport[i];
        // Always use 1-based index for clips, null case gets no clipIndex
        const clipIndex = clip ? i + 1 : undefined;
        const jobId = newJobId();
        setExportJobId(jobId);
        const signal = registerExportAbort(jobId);
        const ws = await openProgressWs(jobId);
        try {
          // Safely extract trim values for this clip with validation and fallbacks
          const trimForExport = clip
            ? getValidatedClipTrim(clip, duration)
            : trimRange;
          await exportVideo({
            videoId,
            segments: useSubs ? segments : [],
            style, position, size, canvas, jobId,
            trimSilences: trim.enabled,
            silenceThresholdSec: trim.threshold_sec,
            silencePaddingSec: trim.padding_sec,
            trim: trimForExport, audio, format, gifQuality,
            watermark, subtitleTrack, clipIndex, signal,
            resolution, fps, optimizeForInstagram,
          });
          const url = downloadUrl(videoId, format, clipIndex);
          if (clipIndex !== undefined) {
            setDownloads((prev) => [...prev, { clipIndex, url, format }]);
          } else {
            const a = document.createElement("a");
            a.href = url;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => a.remove(), 500);
          }
          setProgress("encode", Math.round(((i + 1) / clipsToExport.length) * 100));
        } catch (err) {
          if (isExportCancel(err)) { cancelledByUser = true; break; }
          throw err;
        } finally {
          ws.close();
          clearExportAbort(jobId);
        }
      }
      setProgress(cancelledByUser ? "idle" : "done", cancelledByUser ? 0 : 100);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress("idle", 0);
    } finally {
      setExportJobId(null);
      setBusy("idle");
    }
  }

  if (!videoId) return null;

  return (
    <div className="pane scroll" data-testid="export-panel">
      <div className="pane-header"><h2>Export</h2></div>
      <div className="pane-body">
        <div className="section">
          <label className="inline-label">
            Format
            <select className="export-format" value={format}
              onChange={(e) => setFormat(e.target.value as ExportFormat)}
              disabled={busy !== "idle"}>
              <option value="mp4">MP4</option>
              <option value="gif">GIF</option>
              <option value="mkv">MKV</option>
            </select>
          </label>
          {format === "gif" && (
            <label className="inline-label">
              Quality
              <select className="export-gif-quality" value={gifQuality}
                onChange={(e) => setGifQuality(e.target.value as GifQuality)}
                disabled={busy !== "idle"}>
                <option value="low">Low · 320px · 10fps</option>
                <option value="medium">Medium · 480px · 15fps</option>
                <option value="high">High · 720px · 20fps</option>
              </select>
            </label>
          )}
          {(format === "mp4" || format === "mkv") && (
            <div>
              <label className="inline-label">
                Resolution
                <select className="export-resolution" value={resolution}
                  onChange={(e) => setResolution(e.target.value as ExportResolution)}
                  disabled={busy !== "idle"}>
                  <option value="720p">720p</option>
                  <option value="1080p">1080p</option>
                  <option value="4k">4K</option>
                </select>
              </label>
              <label className="inline-label">
                Frame Rate
                <select className="export-fps" value={fps}
                  onChange={(e) => setFps(Number(e.target.value) as ExportFps)}
                  disabled={busy !== "idle"}>
                  <option value={30}>30 FPS</option>
                  <option value={60}>60 FPS</option>
                </select>
              </label>
              <label className="inline-label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={optimizeForInstagram}
                  onChange={(e) => setOptimizeForInstagram(e.target.checked)}
                  disabled={busy !== "idle"}
                />
                Optimize for Instagram
              </label>
            </div>
          )}
          <button className="primary" style={{ width: "100%" }}
            onClick={() => void onExport()} disabled={busy !== "idle"}>
            {busy === "exporting" ? "Exporting…" : "Export"}
          </button>
        </div>
        {downloads.length > 0 && (
          <div className="section">
            <div className="section-title">Downloads</div>
            {downloads.map((d) => (
              <a key={d.clipIndex} href={d.url}
                className="secondary"
                style={{ display: "inline-block", textAlign: "center" }}>
                Download Clip {d.clipIndex}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
