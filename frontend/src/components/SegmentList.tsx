import { useStore, type Segment } from "../store";

function fmtTimestamp(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t - Math.floor(t)) * 100);
  return `${m}:${s.toString().padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
}

/** SRT timestamp: HH:MM:SS,mmm — note the COMMA before milliseconds, which is
 * required by the SubRip spec (players like Premiere/Aegisub reject a dot). */
function fmtSrtTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const ms = Math.round(t * 1000);
  const pad = (n: number, w: number) => n.toString().padStart(w, "0");
  return (
    `${pad(Math.floor(ms / 3_600_000), 2)}:` +
    `${pad(Math.floor((ms % 3_600_000) / 60_000), 2)}:` +
    `${pad(Math.floor((ms % 60_000) / 1000), 2)},` +
    `${pad(ms % 1000, 3)}`
  );
}

/** Standard SubRip blocks: "N\nstart --> end\ntext", separated by a blank line. */
function buildSrt(segments: Segment[]): string {
  if (segments.length === 0) return "";
  return (
    segments
      .map(
        (seg, i) =>
          `${i + 1}\n${fmtSrtTime(seg.start)} --> ${fmtSrtTime(seg.end)}\n${seg.text}`,
      )
      .join("\n\n") + "\n"
  );
}

/** Name the .srt after the imported video (my_video.mp4 → my_video.srt);
 * falls back to transcript.srt when the original name is unknown. */
function srtFilename(originalFilename: string | null): string {
  const stem = (originalFilename ?? "").trim().replace(/\.[^.\\/]+$/, "").trim();
  const safe = stem.replace(/[\\/:*?"<>|]/g, "_");
  return `${safe || "transcript"}.srt`;
}

export function SegmentList() {
  const segments = useStore((s) => s.segments);
  const segmentsSource = useStore((s) => s.segmentsSource);
  const segmentsExtra = useStore((s) => s.segmentsExtra);
  const subtitleTrack = useStore((s) => s.subtitleTrack);
  const setSubtitleTrack = useStore((s) => s.setSubtitleTrack);
  const updateSegment = useStore((s) => s.updateSegment);
  const deleteSegment = useStore((s) => s.deleteSegment);
  const currentTime = useStore((s) => s.currentTime);
  const hasVideo = useStore((s) => !!s.videoUrl);
  const originalFilename = useStore((s) => s.originalFilename);
  const subsStreaming = useStore((s) => s.subsStreaming);
  const extraSubsStreaming = useStore((s) => s.extraSubsStreaming);
  const progressPhase = useStore((s) => s.progressPhase);
  const progressPercent = useStore((s) => s.progressPercent);
  if (!hasVideo) return null;

  const activeIdx = segments.findIndex(
    (seg) => currentTime >= seg.start && currentTime <= seg.end,
  );

  // The strip + spinner indicators show whichever track is currently being
  // transcribed AND is the active tab in the editor.
  const sourceTranscribing = subsStreaming && progressPhase === "transcribe";
  const extraTranscribing = extraSubsStreaming;
  const transcribing =
    subtitleTrack === "extra" ? extraTranscribing : sourceTranscribing;
  const extraAvailable = segmentsExtra.length > 0 || extraSubsStreaming;

  // Pure client-side export: build the SubRip text from the active track and
  // hand it to the browser via a blob URL. No backend round-trip involved.
  function downloadSrt() {
    if (segments.length === 0) return;
    const blob = new Blob([buildSrt(segments)], {
      type: "application/x-subrip;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = srtFilename(originalFilename);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="pane scroll" data-testid="segments-panel">
      <div className="pane-header">
        <div className="pane-header-left">
          <h2>Transcript</h2>
          <button
            type="button"
            className="srt-download"
            data-testid="srt-download"
            disabled={segments.length === 0}
            onClick={downloadSrt}
            title={
              segments.length === 0
                ? "No transcript segments to download yet"
                : `Download ${srtFilename(originalFilename)} (SubRip .srt)`
            }
          >
            Subtitle Download
          </button>
        </div>
        <span className="topbar-meta">{segments.length}</span>
      </div>
      <div className="subtitle-track-tabs" data-testid="subtitle-track-tabs">
        <button
          type="button"
          className={`subtitle-track-tab${subtitleTrack === "source" ? " active" : ""}`}
          data-testid="subtitle-track-source"
          aria-pressed={subtitleTrack === "source"}
          onClick={() => setSubtitleTrack("source")}
        >
          Source <span className="subtitle-track-count">{segmentsSource.length}</span>
          {sourceTranscribing && <span className="subtitle-track-dot" aria-label="transcribing" />}
        </button>
        <button
          type="button"
          className={`subtitle-track-tab${subtitleTrack === "extra" ? " active" : ""}`}
          data-testid="subtitle-track-extra"
          aria-pressed={subtitleTrack === "extra"}
          disabled={!extraAvailable}
          onClick={() => setSubtitleTrack("extra")}
          title={extraAvailable ? "Switch to extra-audio captions" : "Generate captions from extra audio first"}
        >
          Extra <span className="subtitle-track-count">{segmentsExtra.length}</span>
          {extraTranscribing && <span className="subtitle-track-dot" aria-label="transcribing" />}
        </button>
      </div>
      <div className="pane-body compact">
        {transcribing && segments.length > 0 && (
          <div className="transcribing-strip" data-testid="transcribing-strip">
            <span className="transcribing-dot" aria-hidden />
            <span>Transcribing… {segments.length} segment{segments.length === 1 ? "" : "s"} so far · {progressPercent}%</span>
          </div>
        )}
        {segments.length === 0 ? (
          transcribing ? (
            <div className="transcribing-empty" data-testid="transcribing-empty">
              <div className="transcribing-spinner-wrap" aria-hidden>
                <div className="transcribing-spinner" />
                <span className="transcribing-percent">{progressPercent}%</span>
              </div>
              <div className="transcribing-title">Transcribing with Whisper…</div>
              <div className="transcribing-hint">Segments will appear here as they're recognised.</div>
            </div>
          ) : (
            <p style={{ color: "var(--fg-muted)", fontSize: 13 }}>
              No speech detected yet.
            </p>
          )
        ) : (
          <div className="segments" data-testid="segments-list">
            {segments.map((seg, i) => (
              <div
                key={i}
                className={`segment${i === activeIdx ? " active" : ""}`}
                data-testid={`segment-${i}`}
                data-active={i === activeIdx ? "1" : "0"}
              >
                <div className="segment-time">
                  <input
                    type="number"
                    step="0.1"
                    value={seg.start}
                    data-testid={`segment-${i}-start`}
                    aria-label={`start ${fmtTimestamp(seg.start)}`}
                    onChange={(e) =>
                      updateSegment(i, { start: Number(e.target.value) })
                    }
                  />
                  <input
                    type="number"
                    step="0.1"
                    value={seg.end}
                    data-testid={`segment-${i}-end`}
                    aria-label={`end ${fmtTimestamp(seg.end)}`}
                    onChange={(e) =>
                      updateSegment(i, { end: Number(e.target.value) })
                    }
                  />
                </div>
                <input
                  type="text"
                  className="segment-text"
                  value={seg.text}
                  data-testid={`segment-${i}-text`}
                  onChange={(e) => updateSegment(i, { text: e.target.value })}
                />
                <button
                  className="segment-del"
                  onClick={() => deleteSegment(i)}
                  data-testid={`segment-${i}-delete`}
                  aria-label={`delete segment ${i}`}
                  title="Delete segment (Del at playhead)"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
