import { useState } from "react";
import { cancelExport, cancelTranscribe, cancelTranscribeExtra } from "../api";
import { useStore } from "../store";

const PHASE_LABEL: Record<string, string> = {
  upload: "Uploading",
  download: "Downloading",
  transcribe: "Transcribing",
  align: "Aligning words",
  encode: "Rendering",
};

/** Which cancellation endpoint the Stop button should hit. */
type CancelTarget = "export" | "extra" | "source";

export function ProgressBar() {
  const phase = useStore((s) => s.progressPhase);
  const percent = useStore((s) => s.progressPercent);
  const busy = useStore((s) => s.busy);
  const subsStreaming = useStore((s) => s.subsStreaming);
  const extraSubsStreaming = useStore((s) => s.extraSubsStreaming);
  const videoId = useStore((s) => s.videoId);
  const extraAudioId = useStore((s) => s.audio.extraAudioId);
  const exportJobId = useStore((s) => s.exportJobId);
  const [stopping, setStopping] = useState(false);

  if (phase === "idle" || phase === "done") return null;

  // Precedence mirrors how the phases are produced: an export sets busy, the
  // extra-track whisper owns `extraSubsStreaming`, the upload-time whisper
  // owns `subsStreaming`. Uploads / yt-dlp downloads have no cancel target,
  // so no button is offered while they run.
  const target: CancelTarget | null =
    busy === "exporting"
      ? "export"
      : extraSubsStreaming
        ? "extra"
        : subsStreaming
          ? "source"
          : null;

  async function onStop() {
    if (stopping || target === null) return;
    setStopping(true);
    try {
      if (target === "export") {
        // The backend registers the cancel key under the export job id.
        if (exportJobId) await cancelExport(exportJobId);
      } else if (target === "extra") {
        if (extraAudioId) await cancelTranscribeExtra(extraAudioId);
      } else if (videoId) {
        await cancelTranscribe(videoId);
      }
    } finally {
      // Transcribe/export state is flipped by the terminal WS event
      // (transcribe_cancelled / extra_transcribe_cancelled / export_cancelled)
      // or by TopBar's finally block — never optimistically here.
      setStopping(false);
    }
  }

  return (
    <div
      className="progress"
      data-testid="progress-bar"
      data-phase={phase}
      data-progress={percent}
    >
      <div className="progress-header">
        <span>{PHASE_LABEL[phase] ?? phase}</span>
        <span>{percent}%</span>
      </div>
      <div className="progress-body">
        <div className="progress-bar-track">
          <div className="progress-bar-fill" style={{ width: `${percent}%` }} />
        </div>
        {target !== null && (
          <button
            type="button"
            className="progress-stop"
            onClick={() => void onStop()}
            disabled={stopping}
            data-testid="progress-stop"
            data-cancel-target={target}
            aria-label="Stop"
            title="Stop this operation"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              aria-hidden="true"
              focusable="false"
            >
              <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" fill="currentColor" />
            </svg>
            <span>{stopping ? "Stopping…" : "Stop"}</span>
          </button>
        )}
      </div>
    </div>
  );
}
