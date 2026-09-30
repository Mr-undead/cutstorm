import { useState, useEffect, useRef, useCallback } from "react";
import { useStore } from "../store";

export type ExportFormat = "mp4" | "gif";
export type ExportResolution = "720p" | "1080p" | "4k";
export type ExportFps = 30 | 60;
export type GifQuality = "low" | "medium" | "high";

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ExportState {
  jobId: string | null;
  status: "idle" | "rendering" | "done" | "error" | "cancelled";
  progress: number;
  message: string;
  downloadUrl: string | null;
}

export function ExportModal({ isOpen, onClose }: ExportModalProps) {
  const videoId = useStore((s) => s.videoId);
  const segments = useStore((s) => s.segments);
  const style = useStore((s) => s.style);
  const position = useStore((s) => s.position);
  const size = useStore((s) => s.size);
  const canvas = useStore((s) => s.canvas);
  const trimRange = useStore((s) => s.trimRange);
  const audio = useStore((s) => s.audio);
  const subtitleTrack = useStore((s) => s.subtitleTrack);

  // Settings
  const [format, setFormat] = useState<ExportFormat>("mp4");
  const [resolution, setResolution] = useState<ExportResolution>("1080p");
  const [fps, setFps] = useState<ExportFps>(60);
  const [optimizeForInstagram, setOptimizeForInstagram] = useState(true);
  const [watermark, setWatermark] = useState(false);
  const [gifQuality, setGifQuality] = useState<GifQuality>("medium");

  // Export state
  const [exportState, setExportState] = useState<ExportState>({
    jobId: null,
    status: "idle",
    progress: 0,
    message: "",
    downloadUrl: null,
  });

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const downloadAnchorRef = useRef<HTMLAnchorElement | null>(null);

  // Cleanup polling & abort on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  // Auto-close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") resetAndClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  // Apply Instagram defaults
  useEffect(() => {
    if (optimizeForInstagram) {
      setResolution("1080p");
      setFps(60);
    }
  }, [optimizeForInstagram]);

  const pollProgress = useCallback((jobId: string) => {
    if (!jobId || typeof jobId !== 'string' || jobId.trim() === '') return;
    console.log('Starting export status polling for jobId:', jobId);
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        console.log('Polling export status for:', jobId);
        const controller = new AbortController();
        const res = await fetch(`/api/export/${jobId}/status?t=${Date.now()}`, { signal: controller.signal });
        if (!res.ok) return;
        const data = await res.json();
        console.log('Export status response:', data);
        setExportState((prev) => ({
          ...prev,
          progress: typeof data.progress === 'number' ? data.progress : prev.progress,
          message: data.message ?? prev.message,
          status: data.status ?? prev.status,
        }));
        if (data.status === "done") {
          if (pollRef.current) clearInterval(pollRef.current);
          const downloadUrl = `/api/download/${jobId}`;
          setExportState((prev) => ({ ...prev, downloadUrl }));
          // Auto-download
          if (downloadAnchorRef.current) {
            downloadAnchorRef.current.href = downloadUrl;
            downloadAnchorRef.current.click();
          }
        }
        if (data.status === "error" || data.status === "cancelled") {
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // ignore other poll errors
      }
    }, 1000);
  }, []);

  const startExport = async () => {
    if (!videoId) return;

    setExportState({
      jobId: null,
      status: "rendering",
      progress: 0,
      message: "Starting export…",
      downloadUrl: null,
    });

    try {
      abortRef.current = new AbortController();
      const body: Record<string, unknown> = {
        video_id: videoId,
        segments,
        style,
        position,
        size,
        canvas,
        trim: trimRange,
        audio: {
          source_volume: audio.sourceVolume,
          extra_audio_id: audio.extraAudioId,
          extra_volume: audio.extraVolume,
        },
        subtitle_track: subtitleTrack,
        format,
        resolution,
        fps,
        optimize_for_instagram: optimizeForInstagram,
        watermark,
        gif_quality: gifQuality,
      };

      const res = await fetch(`/api/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const detail = err.detail;
        const msg = Array.isArray(detail)
          ? detail.map((e: { msg?: string }) => e.msg ?? String(e)).join(', ')
          : String(detail ?? 'Export request failed');
        throw new Error(msg);
      }

      const data = await res.json();
      const jobId: string = data.job_id;
      if (!jobId || typeof jobId !== 'string' || jobId.trim() === '') {
        throw new Error('Export failed: no job ID returned from server');
      }
      setExportState((prev) => ({ ...prev, jobId }));
      pollProgress(jobId);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      const message = err instanceof Error ? err.message : "Export failed";
      setExportState((prev) => ({
        ...prev,
        status: "error",
        message,
      }));
    } finally {
      abortRef.current = null;
    }
  };

  const cancelExport = async () => {
    // Abort any in-flight HTTP request (e.g. initial POST)
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    // Send cancel API request if we have a job ID
    const { jobId } = exportState;
    if (jobId) {
      try {
        await fetch(`/api/export/${jobId}/cancel`, { method: "POST" });
      } catch {
        // ignore — server may already be stopped
      }
    }

    // Stop polling immediately
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    // Reset modal state back to idle (no intermediate error/status screen)
    setExportState({
      jobId: null,
      status: "idle",
      progress: 0,
      message: "",
      downloadUrl: null,
    });
  };

  const resetAndClose = () => {
    // Clear any active polling
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    // Clear any active abort controller
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setExportState({
      jobId: null,
      status: "idle",
      progress: 0,
      message: "",
      downloadUrl: null,
    });
    onClose();
  };

  if (!isOpen) return null;

  const isRunning = exportState.status === "rendering";
  const isDone = exportState.status === "done";
  return (
    <div className="modal-overlay" data-testid="export-modal">
      <div className="modal-content export-modal">
        <div className="modal-header">
          <h2>Export</h2>
          <button
            className="icon modal-close"
            onClick={resetAndClose}
            aria-label="Close"
            data-testid="export-modal-close"
          >
            ×
          </button>
        </div>

        {exportState.status === "idle" && (
          <div style={{ padding: "20px 24px" }}>
            {/* Format selector */}
            <fieldset className="export-fieldset">
              <legend>Format</legend>
              <div className="export-option-group">
                {(["mp4", "gif"] as const).map((f) => (
                  <button
                    key={f}
                    className={`export-option-btn ${format === f ? "active" : ""}`}
                    onClick={() => setFormat(f)}
                    data-testid={`format-${f}`}
                  >
                    {f.toUpperCase()}
                  </button>
                ))}
              </div>
            </fieldset>

            {/* Resolution (hidden for GIF) */}
            {format === "mp4" && (
              <fieldset className="export-fieldset">
                <legend>Resolution</legend>
                <div className="export-option-group">
                  {(["720p", "1080p", "4k"] as const).map((r) => (
                    <button
                      key={r}
                      className={`export-option-btn ${resolution === r ? "active" : ""}`}
                      onClick={() => {
                        setResolution(r);
                        if (optimizeForInstagram) setOptimizeForInstagram(false);
                      }}
                      data-testid={`resolution-${r}`}
                    >
                      {r === "4k" ? "4K" : r}
                    </button>
                  ))}
                </div>
              </fieldset>
            )}

            {/* Frame rate (hidden for GIF) */}
            {format === "mp4" && (
              <fieldset className="export-fieldset">
                <legend>Frame Rate</legend>
                <div className="export-option-group">
                  {([30, 60] as const).map((f) => (
                    <button
                      key={f}
                      className={`export-option-btn ${fps === f ? "active" : ""}`}
                      onClick={() => {
                        setFps(f);
                        if (optimizeForInstagram) setOptimizeForInstagram(false);
                      }}
                      data-testid={`fps-${f}`}
                    >
                      {f} FPS
                    </button>
                  ))}
                </div>
              </fieldset>
            )}

            {/* GIF quality */}
            {format === "gif" && (
              <fieldset className="export-fieldset">
                <legend>GIF Quality</legend>
                <div className="export-option-group">
                  {(["low", "medium", "high"] as const).map((q) => (
                    <button
                      key={q}
                      className={`export-option-btn ${gifQuality === q ? "active" : ""}`}
                      onClick={() => setGifQuality(q)}
                      data-testid={`gif-quality-${q}`}
                    >
                      {q.charAt(0).toUpperCase() + q.slice(1)}
                    </button>
                  ))}
                </div>
              </fieldset>
            )}

            {/* Optimize for Instagram */}
            {format === "mp4" && (
              <div
                style={{ display: "flex", alignItems: "center", justifyContent: "flex-start", gap: 12, margin: "12px 0", cursor: "pointer" }}
                onClick={() => setOptimizeForInstagram((prev) => !prev)}
                data-testid="optimize-instagram"
              >
                <input
                  type="checkbox"
                  checked={optimizeForInstagram}
                  onChange={(e) => setOptimizeForInstagram(e.target.checked)}
                  style={{ width: 16, height: 16, accentColor: "#8b5cf6", cursor: "pointer", flexShrink: 0 }}
                  tabIndex={-1}
                />
                <span style={{ fontSize: 13, color: "var(--fg)", cursor: "pointer" }}>Optimize for Instagram</span>
              </div>
            )}

            {/* Watermark */}
            <div
              style={{ display: "flex", alignItems: "center", justifyContent: "flex-start", gap: 12, margin: "12px 0", cursor: "pointer" }}
              onClick={() => setWatermark((prev) => !prev)}
              data-testid="watermark-toggle"
            >
              <input
                type="checkbox"
                checked={watermark}
                onChange={(e) => setWatermark(e.target.checked)}
                style={{ width: 16, height: 16, accentColor: "#8b5cf6", cursor: "pointer", flexShrink: 0 }}
                tabIndex={-1}
              />
              <span style={{ fontSize: 13, color: "var(--fg)", cursor: "pointer" }}>Watermark</span>
            </div>

            <button
              className="primary export-start-btn"
              onClick={startExport}
              disabled={!videoId}
              data-testid="export-start"
            >
              Start Export
              </button>
          </div>
        )}

        {/* Progress */}
        {isRunning && (
          <div className="export-progress" data-testid="export-progress">
            <div className="progress-bar-track">
              <div
                className="progress-bar-fill"
                style={{ width: `${exportState.progress}%` }}
              />
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginTop: 8,
              }}
            >
              <span className="progress-text">
                {exportState.progress}% — {exportState.message}
              </span>
              <button
                className="secondary export-cancel-btn"
                onClick={cancelExport}
                data-testid="export-cancel"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Done */}
        {isDone && (
          <div className="export-done" data-testid="export-done">
            <p>Export complete!</p>
            {exportState.downloadUrl && (
              <a
                className="primary"
                href={exportState.downloadUrl}
                download
                data-testid="export-download-link"
              >
                Download
              </a>
            )}
            <button className="secondary" onClick={resetAndClose}>
              Close
            </button>
          </div>
        )}

        {/* Error */}
        {exportState.status === "error" && (
          <div className="export-error" data-testid="export-error">
            <p>{exportState.message}</p>
            <button className="secondary" onClick={resetAndClose}>
              Close
            </button>
          </div>
        )}

        {/* Hidden anchor for auto-download */}
        <a ref={downloadAnchorRef} style={{ display: "none" }} />
      </div>
    </div>
  );
}
