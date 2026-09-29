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
  const audio = useStore((s) => s.audio);
  const watermark = useStore((s) => s.watermark);
  const subtitleTrack = useStore((s) => s.subtitleTrack);
  const busy = useStore((s) => s.busy);
  const setBusy = useStore((s) => s.setBusy);
  const setError = useStore((s) => s.setError);
  const setProgress = useStore((s) => s.setProgress);
  const setExportJobId = useStore((s) => s.setExportJobId);
  const [format, setFormat] = useState<ExportFormat>("mp4");
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
    const clipsToExport = clips.length > 0 ? clips : [null];
    let cancelledByUser = false;
    try {
      for (let i = 0; i < clipsToExport.length; i += 1) {
        const clip = clipsToExport[i];
        const clipIndex = clip ? i + 1 : undefined;
        const jobId = newJobId();
        setExportJobId(jobId);
        const signal = registerExportAbort(jobId);
        const ws = await openProgressWs(jobId);
        try {
          const trimForExport = clip
            ? { in_sec: clip.in_sec, out_sec: clip.out_sec, loop: false }
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
          });
          const url = downloadUrl(videoId, format, clipIndex);
          if (clipIndex !== undefined) {
            setDownloads((prev) => [...prev, { clipIndex, url, format }]);
          } else {
            const a = document.createElement("a");
            a.href = url;
            a.download = `${videoId}.${format}`;
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
                download={`clip-${d.clipIndex.toString().padStart(2, "0")}.${d.format}`}
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
