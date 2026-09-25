import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelTranscribeExtra,
  transcribeExtra,
  uploadExtraAudio,
} from "../api";
import { clearExtraBlob, getExtraBlob, setExtraBlob } from "../extraBlobs";
import { newJobId, openProgressWs } from "../progress";
import { useStore } from "../store";
import { computePeaks } from "../waveform";

function fmt(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t - Math.floor(t)) * 100);
  return `${m}:${s.toString().padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
}

function parseTime(value: string): number | null {
  const text = value.trim();
  if (!text) return null;

  // Plain seconds, e.g. 15 or 15.5
  if (/^\d+(\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? seconds : null;
  }

  const parts = text.split(":");
  if (parts.length < 2 || parts.length > 3) return null;

  const numbers = parts.map(Number);
  if (numbers.some((n) => !Number.isFinite(n) || n < 0)) return null;

  if (parts.length === 2) {
    const [minutes, seconds] = numbers;
    if (seconds >= 60) return null;
    return minutes * 60 + seconds;
  }

  const [hours, minutes, seconds] = numbers;
  if (minutes >= 60 || seconds >= 60) return null;

  return hours * 3600 + minutes * 60 + seconds;
}

const THUMB_COUNT = 40;
const THUMB_WIDTH = 160;

export function Timeline() {
  const duration = useStore((s) => s.duration);
  const videoUrl = useStore((s) => s.videoUrl);
  const videoId = useStore((s) => s.videoId);
  const isAudioOnly = useStore((s) => s.isAudioOnly);
  const currentTime = useStore((s) => s.currentTime);
  const trimRange = useStore((s) => s.trimRange);
  const setTrimRange = useStore((s) => s.setTrimRange);
  const clips = useStore((s) => s.clips);
  const activeClipId = useStore((s) => s.activeClipId);
  const addClip = useStore((s) => s.addClip);
  const removeClip = useStore((s) => s.removeClip);
  const selectClip = useStore((s) => s.selectClip);
  const audio = useStore((s) => s.audio);
  const setAudio = useStore((s) => s.setAudio);
  const setError = useStore((s) => s.setError);
  const setLoop = useStore((s) => s.setLoop);

  if (!videoUrl || !duration) return null;

  const outSec = trimRange.out_sec > 0 ? trimRange.out_sec : duration;
  const inSec = trimRange.in_sec;
  const kept = Math.max(0, outSec - inSec);
  const thumbsUrl = videoId && !isAudioOnly
    ? `/api/thumbnails/${videoId}?count=${THUMB_COUNT}&width=${THUMB_WIDTH}`
    : null;
  const loopArmed = !!trimRange.loop;
  const loopActive = loopArmed && audio.extraAudioId !== null && audio.extraAudioDuration > 0;

  return (
    <div className="timeline" data-testid="timeline">
      <TrimBar
        duration={duration}
        inSec={inSec}
        outSec={outSec}
        currentTime={currentTime}
        outStored={trimRange.out_sec}
        thumbsUrl={thumbsUrl}
        thumbCount={THUMB_COUNT}
        onChange={(patch) => setTrimRange(patch)}
      />

     <TrimTimeInputs
       duration={duration}
       inSec={inSec}
       outSec={outSec}
       onChange={(patch) => setTrimRange(patch)}
      />

            <div className="clips-panel" data-testid="clips-panel">
        <div className="clips-header">
          <span>Clips</span>
          <button
            type="button"
            className="clips-add-button"
            onClick={addClip}
          >
            + Add Clip
          </button>
        </div>

        {clips.length > 0 && (
          <div className="clips-list">
            {clips.map((clip, index) => (
              <div
                key={clip.id}
                className={`clip-row ${
                  activeClipId === clip.id ? "active" : ""
                }`}
                onClick={() => selectClip(clip.id)}
              >
                <span className="clip-number">
                  Clip {index + 1}
                </span>

                <span className="clip-range">
                  {fmt(clip.in_sec)} → {fmt(clip.out_sec)}
                </span>

                <button
                  type="button"
                  className="clip-remove-button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeClip(clip.id);
                  }}
                  title="Remove clip"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="timeline-meta" data-testid="timeline-meta">
        <span>{fmt(inSec)}</span>
        <span style={{ opacity: 0.4 }}>—</span>
        <span>{fmt(outSec)}</span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span>{kept.toFixed(2)}s kept</span>
        <span style={{ opacity: 0.4 }}>·</span>
        <label className="loop-toggle" data-testid="loop-toggle-label" title="Loop the selected slice across the extra audio's full duration (Coub mode)">
          <input
            type="checkbox"
            data-testid="loop-toggle"
            checked={loopArmed}
            onChange={(e) => setLoop(e.target.checked)}
          />
          <span>Loop</span>
          {loopActive && (
            <span className="loop-target" data-testid="loop-target">
              → {audio.extraAudioDuration.toFixed(1)}s
            </span>
          )}
          {loopArmed && !loopActive && (
            <span className="loop-hint" data-testid="loop-hint">(needs extra audio)</span>
          )}
        </label>
      </div>

      {/* tracks temporarily disabled for debugging */}
      <SourceTrack
        videoId={videoId}
        volume={audio.sourceVolume}
        onVolume={(v) => setAudio({ sourceVolume: v })}
        currentTime={currentTime}
        duration={duration}
        inSec={inSec}
        outSec={outSec}
      />
      <ExtraTrack
        audio={audio}
        setAudio={setAudio}
        setError={setError}
        duration={duration}
      />
    </div>
  );
}

// ---------- Manual trim inputs ----------

function TrimTimeInputs({
  duration,
  inSec,
  outSec,
  onChange,
}: {
  duration: number;
  inSec: number;
  outSec: number;
  onChange: (patch: { in_sec?: number; out_sec?: number }) => void;
}) {
  const [startText, setStartText] = useState(fmt(inSec));
  const [endText, setEndText] = useState(fmt(outSec));

  useEffect(() => {
    setStartText(fmt(inSec));
  }, [inSec]);

  useEffect(() => {
    setEndText(fmt(outSec));
  }, [outSec]);

  function commitStart() {
    const value = parseTime(startText);

    if (value === null) {
      setStartText(fmt(inSec));
      return;
    }

    const next = Math.max(0, Math.min(duration, value));

    if (next >= outSec) {
      setStartText(fmt(inSec));
      return;
    }

    onChange({ in_sec: next });
  }

  function commitEnd() {
    const value = parseTime(endText);

    if (value === null) {
      setEndText(fmt(outSec));
      return;
    }

    const next = Math.max(0, Math.min(duration, value));

    if (next <= inSec) {
      setEndText(fmt(outSec));
      return;
    }

    onChange({ out_sec: next });
  }

  return (
    <div className="trim-inputs" data-testid="trim-inputs">
      <label className="trim-input-group">
        <span>Start</span>
        <input
          type="text"
          value={startText}
          onChange={(e) => setStartText(e.target.value)}
          onBlur={commitStart}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
            if (e.key === "Escape") {
              setStartText(fmt(inSec));
              e.currentTarget.blur();
            }
          }}
          aria-label="Trim start time"
          placeholder="0:00.00"
          spellCheck={false}
        />
      </label>

      <span className="trim-input-separator">→</span>

      <label className="trim-input-group">
        <span>End</span>
        <input
          type="text"
          value={endText}
          onChange={(e) => setEndText(e.target.value)}
          onBlur={commitEnd}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
            if (e.key === "Escape") {
              setEndText(fmt(outSec));
              e.currentTarget.blur();
            }
          }}
          aria-label="Trim end time"
          placeholder="0:00.00"
          spellCheck={false}
        />
      </label>

      <span className="trim-duration">
        {Math.max(0, outSec - inSec).toFixed(2)}s
      </span>
    </div>
  );
}

// ---------- Trim handles ----------

function TrimBar({
  duration,
  inSec,
  outSec,
  currentTime,
  outStored,
  thumbsUrl,
  onChange,
}: {
  duration: number;
  inSec: number;
  outSec: number;
  currentTime: number;
  outStored: number;
  thumbsUrl: string | null;
  thumbCount: number;
  onChange: (patch: { in_sec?: number; out_sec?: number }) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ which: "in" | "out"; startX: number; startIn: number; startOut: number } | null>(null);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    const root = rootRef.current;
    if (!d || !root) return;
    const rect = root.getBoundingClientRect();
    if (rect.width <= 0) return;
    const dx = (e.clientX - d.startX) / rect.width;
    const dt = dx * duration;
    if (d.which === "in") {
      let next = Math.max(0, Math.min(duration - 0.1, d.startIn + dt));
      const cap = outStored > 0 ? d.startOut : duration;
      next = Math.min(next, cap - 0.1);
      onChange({ in_sec: next });
    } else {
      let next = Math.max(d.startIn + 0.1, Math.min(duration, d.startOut + dt));
      onChange({ out_sec: next });
    }
  }, [duration, outStored, onChange]);

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  }, [onPointerMove]);

  function startDrag(which: "in" | "out") {
    return (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = {
        which,
        startX: e.clientX,
        startIn: inSec,
        startOut: outStored > 0 ? outStored : duration,
      };
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    };
  }

  const inPct = Math.max(0, Math.min(100, (inSec / duration) * 100));
  const outPct = Math.max(0, Math.min(100, (outSec / duration) * 100));
  const ctPct = Math.max(0, Math.min(100, (currentTime / duration) * 100));

  // Sprite sheet = one long JPG with `thumbCount` tiles across. To render it
  // as a lane, we set background-size so the sprite's full width equals the
  // bar's width × thumbCount / thumbCount → exactly stretched horizontally.
  const thumbStyle: React.CSSProperties = thumbsUrl
    ? {
        backgroundImage: `url(${thumbsUrl})`,
        backgroundRepeat: "no-repeat",
        backgroundSize: "100% 100%",
      }
    : {};

  return (
    <div className="trim-bar" data-testid="trim-bar" ref={rootRef}>
      <div className="trim-thumbs" style={thumbStyle} />
      <div
        className="trim-dim trim-dim-left"
        style={{ width: `${inPct}%` }}
      />
      <div
        className="trim-dim trim-dim-right"
        style={{ left: `${outPct}%`, width: `${Math.max(0, 100 - outPct)}%` }}
      />
      <div
        className="trim-keep-frame"
        style={{ left: `${inPct}%`, width: `${Math.max(0, outPct - inPct)}%` }}
      />
      <div className="trim-playhead" style={{ left: `${ctPct}%` }} data-testid="trim-playhead" />
      <div
        className="trim-handle trim-handle-in"
        style={{ left: `${inPct}%` }}
        onPointerDown={startDrag("in")}
        data-testid="trim-handle-in"
        title={`In ${inSec.toFixed(2)}s`}
      />
      <div
        className="trim-handle trim-handle-out"
        style={{ left: `${outPct}%` }}
        onPointerDown={startDrag("out")}
        data-testid="trim-handle-out"
        title={`Out ${outSec.toFixed(2)}s`}
      />
    </div>
  );
}

// ---------- Source waveform + volume ----------

function SourceTrack({
  videoId,
  volume,
  onVolume,
  currentTime,
  duration,
  inSec,
  outSec,
}: {
  videoId: string | null;
  volume: number;
  onVolume: (v: number) => void;
  currentTime: number;
  duration: number;
  inSec: number;
  outSec: number;
}) {
  const peaks = useServerPeaks(videoId);
  const inPct = (inSec / duration) * 100;
  const outPct = (outSec / duration) * 100;
  const ctPct = (currentTime / duration) * 100;
  return (
    <div className="track-row" data-testid="source-track">
      <div className="track-label">
        <span className="track-label-text">Audio</span>
        <VolumeSlider value={volume} onChange={onVolume} testId="source-volume" />
      </div>
      <div className="track-body">
        <WaveformBar
          peaks={peaks}
          widthPct={100}
          inPct={inPct}
          outPct={outPct}
          currentPct={ctPct}
        />
      </div>
    </div>
  );
}

// ---------- Extra track ----------

function ExtraTrack({
  audio,
  setAudio,
  setError,
  duration,
}: {
  audio: ReturnType<typeof useStore.getState>["audio"];
  setAudio: (p: Partial<ReturnType<typeof useStore.getState>["audio"]>) => void;
  setError: (msg: string | null) => void;
  duration: number;
}) {
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const peakKey = audio.extraAudioId ? `extra:${audio.extraAudioId}` : null;
  const extraBlobUrl = useExtraBlobUrl(audio.extraAudioId);
  // Prefer server-computed peaks; fall back to client decode of the blob.
  const extraServerPeaks = useServerExtraPeaks(audio.extraAudioId);
  const decodedPeaks = useWaveform(peakKey, extraBlobUrl);

  const setExtraSegments = useStore((s) => s.setExtraSegments);
  const setSubtitleTrack = useStore((s) => s.setSubtitleTrack);
  const setExtraSubsStreaming = useStore((s) => s.setExtraSubsStreaming);
  const setProgress = useStore((s) => s.setProgress);
  const setJobId = useStore((s) => s.setJobId);
  const extraSubsStreaming = useStore((s) => s.extraSubsStreaming);
  const segmentsExtra = useStore((s) => s.segmentsExtra);

  // After a project reload the store has the extra_audio_id but no name/
  // duration (those weren't in meta.json). Rehydrate from /info so the
  // waveform width and the toolbar duration display correctly.
  useEffect(() => {
    const id = audio.extraAudioId;
    if (!id) return;
    if (audio.extraAudioDuration > 0 && audio.extraAudioName) return;
    let cancelled = false;
    fetch(`/api/extra-audio/${encodeURIComponent(id)}/info`)
      .then((r) => (r.ok ? r.json() : null))
      .then((info) => {
        if (cancelled || !info) return;
        setAudio({
          extraAudioDuration: Number(info.duration) || 0,
          extraAudioName: audio.extraAudioName ?? `extra.${info.ext ?? "audio"}`,
        });
      })
      .catch(() => { /* network — skip silently, user will see stale 0s */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audio.extraAudioId]);

  async function onFile(file: File) {
    setUploading(true);
    setError(null);
    try {
      const res = await uploadExtraAudio(file);
      setExtraBlob(res.extra_audio_id, URL.createObjectURL(file));
      setAudio({
        extraAudioId: res.extra_audio_id,
        extraAudioName: res.name,
        extraAudioDuration: res.duration,
      });
      // Fresh extra audio invalidates any prior extra-track transcript.
      setExtraSegments([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  function clear() {
    if (audio.extraAudioId) clearExtraBlob(audio.extraAudioId);
    setAudio({ extraAudioId: null, extraAudioName: null, extraAudioDuration: 0 });
    setExtraSegments([]);
    // If user was viewing extra-track captions, fall back to source.
    if (useStore.getState().subtitleTrack === "extra") {
      setSubtitleTrack("source");
    }
  }

  async function onTranscribeExtra() {
    if (!audio.extraAudioId) return;
    // Reset segments + flip the active track BEFORE we start so the live
    // stream lands in front of the user immediately and the source-track
    // tab doesn't appear to "lose" its segments mid-stream.
    setExtraSegments([]);
    setSubtitleTrack("extra");
    setExtraSubsStreaming(true);
    setProgress("transcribe", 0);
    setError(null);

    const jobId = newJobId();
    setJobId(jobId);
    let ws: WebSocket | null = null;
    try {
      ws = await openProgressWs(jobId);
      // Fire the request — the WS is already listening for `extra_segment`
      // events from the worker thread, so segments arrive in real time. The
      // HTTP response is just the final summary.
      const res = await transcribeExtra(audio.extraAudioId, {
        language: "en",
        jobId,
      });
      // Idempotent backstop: if the WS missed any tail events (network
      // hiccup), the HTTP response carries the canonical segment list.
      if (Array.isArray(res.segments) && res.segments.length > 0) {
        useStore.getState().mergeExtraSegments(res.segments);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setExtraSubsStreaming(false);
      setProgress("idle", 0);
      setJobId(null);
    } finally {
      // progress.ts closes the socket on extra_transcribe_done/cancelled/error;
      // this is just defensive cleanup if the HTTP path errored before the WS
      // got the terminal event.
      if (!useStore.getState().extraSubsStreaming) {
        try { ws?.close(); } catch { /* */ }
      }
    }
  }

  async function onCancelExtraTranscribe() {
    if (!audio.extraAudioId) return;
    void cancelTranscribeExtra(audio.extraAudioId);
    // Don't clear streaming flag here — wait for the server to push
    // extra_transcribe_cancelled, which progress.ts handles. This way the
    // strip stays visible until the worker actually stops.
  }

  if (!audio.extraAudioId) {
    return (
      <div className="track-row track-row-empty" data-testid="extra-track-empty">
        <div className="track-label">Extra</div>
        <button
          type="button"
          className="track-add"
          data-testid="extra-track-add"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? "Uploading…" : "+ Add audio track (mp3/wav/m4a/ogg/flac/aac)"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac"
          data-testid="extra-file-input"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = "";
          }}
        />
      </div>
    );
  }

  // Extra width is proportional to extraDuration / videoDuration. The
  // waveform is drawn ONLY in that sub-region of the bar; the rest is rail.
  const extraWidthPct = Math.min(100, (audio.extraAudioDuration / Math.max(0.01, duration)) * 100);
  const hasExtraSubs = segmentsExtra.length > 0;
  return (
    <div className="track-row" data-testid="extra-track">
      <div className="track-label">
        <span className="track-label-text">Extra</span>
        <VolumeSlider value={audio.extraVolume} onChange={(v) => setAudio({ extraVolume: v })} testId="extra-volume" />
      </div>
      <div className="track-body">
        <WaveformBar
          peaks={extraServerPeaks ?? decodedPeaks}
          variant="extra"
          widthPct={extraWidthPct}
          inPct={0}
          outPct={100}
          currentPct={null}
        />
        <div className="track-extra-info" data-testid="extra-track-info">
          <span className="track-extra-name" title={audio.extraAudioName ?? ""}>
            🎵 {audio.extraAudioName ?? "extra"}
          </span>
          <span className="track-extra-dur">{audio.extraAudioDuration.toFixed(1)}s</span>
          {extraSubsStreaming ? (
            <button
              type="button"
              className="extra-transcribe-button extra-transcribe-cancel"
              data-testid="extra-transcribe-cancel"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onCancelExtraTranscribe}
              title="Stop transcribing this track"
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className="extra-transcribe-button"
              data-testid="extra-transcribe-button"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onTranscribeExtra}
              title="Run whisper on this audio track and add a separate subtitle track"
            >
              {hasExtraSubs ? "Re-generate subs" : "Generate subs"}
            </button>
          )}
          <button
            type="button"
            className="track-extra-remove"
            data-testid="extra-track-remove"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={clear}
            title="Remove extra track"
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Supporting primitives ----------

function VolumeSlider({
  value,
  onChange,
  testId,
}: {
  value: number;
  onChange: (v: number) => void;
  testId: string;
}) {
  const icon = value < 0.01 ? "🔇" : value < 0.6 ? "🔈" : value < 1.2 ? "🔉" : "🔊";
  return (
    <div className="vol-wrap">
      <span className="vol-icon" aria-hidden>{icon}</span>
      <input
        type="range"
        min={0}
        max={2}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        data-testid={testId}
        className="vol-slider"
      />
      <label className="vol-label">{Math.round(value * 100)}%</label>
    </div>
  );
}

function WaveformBar({
  peaks,
  widthPct,
  inPct,
  outPct,
  currentPct,
  variant,
}: {
  peaks: Float32Array | null;
  /** % of the wave-wrap width that the peaks actually occupy (rest is rail). */
  widthPct: number;
  /** Trim-in dim overlay position, in % of wave-wrap width. */
  inPct: number;
  /** Trim-out dim overlay position, in % of wave-wrap width. */
  outPct: number;
  currentPct: number | null;
  variant?: "source" | "extra";
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const dpr = window.devicePixelRatio || 1;
    const render = () => {
      const wFull = parent.clientWidth;
      const h = parent.clientHeight;
      if (!wFull || !h) return;
      canvas.width = Math.round(wFull * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = wFull + "px";
      canvas.style.height = h + "px";
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, wFull, h);
      const mid = h / 2;
      // Rail across full width (so empty audio still reads as a track).
      ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
      ctx.fillRect(0, mid - 1, wFull, 2);

      // Peaks occupy only widthPct % of the bar — the rest stays as rail.
      const drawW = Math.max(0, Math.min(wFull, (wFull * widthPct) / 100));
      if (peaks && peaks.length > 0 && drawW > 0) {
        const fill = variant === "extra" ? "rgba(255, 196, 0, 0.85)" : "rgba(124, 92, 255, 0.85)";
        ctx.fillStyle = fill;
        const barW = Math.max(1, drawW / peaks.length);
        for (let i = 0; i < peaks.length; i++) {
          const amp = peaks[i] * (h * 0.9) * 0.5;
          const x = i * barW;
          ctx.fillRect(x, mid - amp, Math.max(1, barW - 1), Math.max(2, amp * 2));
        }
      }
    };
    render();
    const ro = new ResizeObserver(render);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [peaks, variant, widthPct]);

  return (
    <div className="wave-wrap">
      <canvas ref={canvasRef} className="wave-canvas" />
      <div
        className="wave-dim wave-dim-left"
        style={{ width: `${Math.max(0, inPct)}%` }}
      />
      <div
        className="wave-dim wave-dim-right"
        style={{ left: `${outPct}%`, width: `${Math.max(0, 100 - outPct)}%` }}
      />
      {currentPct !== null && (
        <div className="wave-playhead" style={{ left: `${currentPct}%` }} />
      )}
    </div>
  );
}

// ---------- Hooks ----------

const peakCache = new Map<string, Float32Array | null>();

function useWaveform(key: string | null, url: string | null): Float32Array | null {
  const [peaks, setPeaks] = useState<Float32Array | null>(
    key ? peakCache.get(key) ?? null : null,
  );
  useEffect(() => {
    if (!key || !url) {
      setPeaks(null);
      return;
    }
    const cached = peakCache.get(key);
    if (cached !== undefined) {
      setPeaks(cached);
      return;
    }
    let cancelled = false;
    computePeaks(url).then((p) => {
      peakCache.set(key, p);
      if (!cancelled) setPeaks(p);
    });
    return () => { cancelled = true; };
  }, [key, url]);
  return peaks;
}

function useExtraBlobUrl(extraId: string | null): string | null {
  return getExtraBlob(extraId);
}

// --- server peaks (backend ffmpeg-computed, cheap) ---

const serverPeaksCache = new Map<string, Float32Array | null>();

function fetchServerPeaks(url: string, cacheKey: string): Promise<Float32Array | null> {
  const cached = serverPeaksCache.get(cacheKey);
  if (cached !== undefined) return Promise.resolve(cached);
  return fetch(url)
    .then((r) => (r.ok ? r.json() : null))
    .then((data: { peaks: number[] } | null) => {
      const arr = data?.peaks ? Float32Array.from(data.peaks) : null;
      serverPeaksCache.set(cacheKey, arr);
      return arr;
    })
    .catch(() => {
      serverPeaksCache.set(cacheKey, null);
      return null;
    });
}

function useServerPeaks(videoId: string | null): Float32Array | null {
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  useEffect(() => {
    if (!videoId) { setPeaks(null); return; }
    let cancelled = false;
    fetchServerPeaks(`/api/peaks/${videoId}?bins=500`, `video:${videoId}`).then((p) => {
      if (!cancelled) setPeaks(p);
    });
    return () => { cancelled = true; };
  }, [videoId]);
  return peaks;
}

function useServerExtraPeaks(extraId: string | null): Float32Array | null {
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  useEffect(() => {
    if (!extraId) { setPeaks(null); return; }
    let cancelled = false;
    fetchServerPeaks(`/api/peaks/extra/${extraId}?bins=500`, `extra:${extraId}`).then((p) => {
      if (!cancelled) setPeaks(p);
    });
    return () => { cancelled = true; };
  }, [extraId]);
  return peaks;
}
