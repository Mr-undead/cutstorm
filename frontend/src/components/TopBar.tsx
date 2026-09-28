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
import logoUrl from "../assets/lockup.png";
import { newJobId, openProgressWs } from "../progress";
import { useStore } from "../store";
import { HotkeysHelp } from "./HotkeysHelp";
import { UndoRedo } from "./UndoRedo";

function fmtTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type TopBarProps = {
  onOpenSidebar: () => void;
};

export function TopBar({ onOpenSidebar }: TopBarProps) {
  const videoId = useStore((s) => s.videoId);
  const duration = useStore((s) => s.duration);
  const videoW = useStore((s) => s.videoW);
  const videoH = useStore((s) => s.videoH);
  const segments = useStore((s) => s.segments);
  const subtitleTrack = useStore((s) => s.subtitleTrack);
  const style = useStore((s) => s.style);
  const position = useStore((s) => s.position);
  const size = useStore((s) => s.size);
  const trim = useStore((s) => s.trim);
  const trimRange = useStore((s) => s.trimRange);
  const clips = useStore((s) => s.clips);
  const audio = useStore((s) => s.audio);
  const canvas = useStore((s) => s.canvas);
  const useSubs = useStore((s) => s.useSubs);
  const watermark = useStore((s) => s.watermark);
  const busy = useStore((s) => s.busy);
  const setBusy = useStore((s) => s.setBusy);
  const setError = useStore((s) => s.setError);
  const setProgress = useStore((s) => s.setProgress);
  const setExportJobId = useStore((s) => s.setExportJobId);
  const newProject = useStore((s) => s.newProject);
  const [format, setFormat] = useState<ExportFormat>("mp4");
  const [gifQuality, setGifQuality] = useState<GifQuality>("medium");
  const [downloads, setDownloads] = useState<
    Array<{
      clipIndex: number;
      url: string;
      format: ExportFormat;
    }>
  >([]);

    async function onExport() {
    if (!videoId) return;

    setBusy("exporting");
    setError(null);
    setProgress("encode", 0);
    setDownloads([]);

    const clipsToExport = clips.length > 0 ? clips : [null];
    // Set when the user hits Stop on the progress bar: the remaining clips are
    // skipped and no error toast is shown (cancellation is not a failure).
    let cancelledByUser = false;

    try {
      for (let i = 0; i < clipsToExport.length; i += 1) {
        const clip = clipsToExport[i];
        const clipIndex = clip ? i + 1 : undefined;

        const jobId = newJobId();
        // Exposed to the ProgressBar's Stop button, which POSTs to
        // /api/export/{jobId}/cancel.
        setExportJobId(jobId);
        const signal = registerExportAbort(jobId);
        const ws = await openProgressWs(jobId);

        try {
          const trimForExport = clip
            ? {
                in_sec: clip.in_sec,
                out_sec: clip.out_sec,
                loop: false,
              }
            : trimRange;

          await exportVideo({
            videoId,
            segments: useSubs ? segments : [],
            style,
            position,
            size,
            canvas,
            jobId,
            trimSilences: trim.enabled,
            silenceThresholdSec: trim.threshold_sec,
            silencePaddingSec: trim.padding_sec,
            trim: trimForExport,
            audio,
            format,
            gifQuality,
            watermark,
            subtitleTrack,
            clipIndex,
            signal,
          });

          const url = downloadUrl(videoId, format, clipIndex);

          if (clipIndex !== undefined) {
            setDownloads((prev) => [
              ...prev,
              {
                clipIndex,
                url,
                format,
              },
            ]);
          } else {
            const a = document.createElement("a");
            a.href = url;
            a.download = `${videoId}.${format}`;
            a.setAttribute("data-testid", "download-link");
            document.body.appendChild(a);
            a.click();
            setTimeout(() => a.remove(), 500);
          }

          setProgress(
            "encode",
            Math.round(((i + 1) / clipsToExport.length) * 100),
          );
        } catch (err) {
          // Stop was pressed: the backend killed the render and deleted the
          // partial output, so this is a clean cancel — not a failure.
          if (isExportCancel(err)) {
            cancelledByUser = true;
            break;
          }
          throw err;
        } finally {
          ws.close();
          clearExportAbort(jobId);
        }
      }

      if (cancelledByUser) {
        setProgress("idle", 0);
      } else {
        setProgress("done", 100);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress("idle", 0);
    } finally {
      setExportJobId(null);
      setBusy("idle");
    }
  }

  return (
    <header className="topbar">
      <div className="brand">
        <button
          className="icon burger"
          onClick={onOpenSidebar}
          aria-label="Open saved projects"
          data-testid="open-sidebar"
          title="Saved projects"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </button>
        <img src={logoUrl} alt="Cut/Storm" className="brand-logo" />
      </div>
      <div className="topbar-right">
        {videoId && (
          <>
            <span className="topbar-meta">
              {videoW}×{videoH} · {fmtTime(duration)} · {segments.length} segments
            </span>
            <UndoRedo />
            <HotkeysHelp />
            <button
              className="secondary"
              onClick={() => void newProject()}
              disabled={busy !== "idle"}
              data-testid="new-project"
            >
              New Project
            </button>
            <div className="export-group">
              <select
                className="export-format"
                data-testid="export-format"
                value={format}
                onChange={(e) => setFormat(e.target.value as ExportFormat)}
                disabled={busy !== "idle"}
                aria-label="Export format"
              >
                <option value="mp4">MP4</option>
                <option value="gif">GIF</option>
              </select>
              {format === "gif" && (
                <select
                  className="export-gif-quality"
                  data-testid="export-gif-quality"
                  value={gifQuality}
                  onChange={(e) => setGifQuality(e.target.value as GifQuality)}
                  disabled={busy !== "idle"}
                  aria-label="GIF quality"
                >
                  <option value="low">Low · 320px · 10fps</option>
                  <option value="medium">Medium · 480px · 15fps</option>
                  <option value="high">High · 720px · 20fps</option>
                </select>
              )}
              <button
                className="primary"
                onClick={onExport}
                disabled={busy !== "idle"}
                data-testid="export-button"
              >
                {busy === "exporting" ? "Exporting…" : "Export"}
              </button>
            </div>
            {downloads.length > 0 && (
              <div className="clip-downloads">
                {downloads.map((download) => (
                  <a
                    key={download.clipIndex}
                    href={download.url}
                    download={`clip-${download.clipIndex
                      .toString()
                      .padStart(2, "0")}.${download.format}`}
                    className="secondary"
                    data-testid={`download-clip-${download.clipIndex}`}
                  >
                    Download Clip {download.clipIndex}
                  </a>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </header>
  );
}
