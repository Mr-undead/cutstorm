import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { uploadVideo, videoUrl } from "../api";
import { LANGUAGES, PINNED_LANGUAGES } from "../languages";
import { newJobId, openProgressWs } from "../progress";
import { useStore } from "../store";

const QUALITY = [
  { value: "large-v3", label: "Best (large-v3)" },
  { value: "small", label: "Fast (small)" },
  { value: "tiny", label: "Test (tiny)" },
];

export function Uploader() {
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = useStore((s) => s.busy);
  const hasVideo = useStore((s) => !!s.videoUrl);
  const setBusy = useStore((s) => s.setBusy);
  const setUploaded = useStore((s) => s.setUploaded);
  const setError = useStore((s) => s.setError);
  const setProgress = useStore((s) => s.setProgress);
  const generateSubs = useStore((s) => s.generateSubs);
  const setGenerateSubs = useStore((s) => s.setGenerateSubs);
  const setSubsStreaming = useStore((s) => s.setSubsStreaming);
  const setUseSubs = useStore((s) => s.setUseSubs);
  const setJobId = useStore((s) => s.setJobId);
  const progressPhase = useStore((s) => s.progressPhase);
  const [language, setLanguage] = useState<string>("en");
  const [model, setModel] = useState<string>("large-v3");
  const [dragActive, setDragActive] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  async function doUpload(file: File) {
    setBusy("uploading");
    setError(null);
    setProgress("upload", 0);
    setSubsStreaming(false);

    const jobId = newJobId();
    setJobId(jobId);
    const ws = await openProgressWs(jobId);
    wsRef.current = ws;
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const result = await uploadVideo(file, {
        jobId,
        language,
        model,
        generateSubs,
        signal: ctrl.signal,
        onUploadProgress: (pct) => setProgress("upload", pct),
      });
      setUploaded({ ...result, url: videoUrl(result.video_id) });
      // Sync editor-side "Show & export subtitles" toggle with the upload choice:
      // if user said "no subs" at upload, the editor toggle must also start OFF.
      setUseSubs(generateSubs);
      // If we asked backend to generate subtitles AND it returned empty segments,
      // the bg task is now running — expect streamed segments via WS. Hold the
      // progress bar on "transcribe 0%"; WS events will bump it. Otherwise mark done.
      if (generateSubs && result.segments.length === 0) {
        setSubsStreaming(true);
        setProgress("transcribe", 0);
      } else {
        setProgress("done", 100);
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      setBusy("idle");
      setProgress("idle", 0);
    } finally {
      abortRef.current = null;
      // When bg transcription is streaming, keep the WS open so progress.ts
      // can receive 'segment' events. The WS self-closes in progress.ts on
      // transcribe_done/cancelled/error. For the non-streaming path, close now.
      if (!useStore.getState().subsStreaming) {
        wsRef.current = null;
        ws.close();
      }
    }
  }



  function cancel() {
    abortRef.current?.abort();
    wsRef.current?.close();
    setBusy("idle");
    setProgress("idle", 0);
    setJobId(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void doUpload(file);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    if (busy !== "idle") return;
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const typeOk = file.type.startsWith("video/") || file.type.startsWith("audio/") || file.type === "image/gif";
    const extOk = /\.(mp4|mov|mkv|webm|avi|gif|mp3|wav|m4a|ogg|flac|aac)$/i.test(file.name);
    if (!typeOk && !extOk) {
      setError("Please drop a video or audio file.");
      return;
    }
    void doUpload(file);
  }

  if (hasVideo) return null;

  const disabled = busy !== "idle";

  return (
    <div className="start-screen" data-testid="uploader">
      <div className="start-card">
        <div className="start-title">
          <h1>Start a new caption project</h1>
        </div>



        <div
          className={`dropzone${dragActive ? " active" : ""}${disabled ? " disabled" : ""}`}
          onDragOver={(e) => {
            if (disabled) return;
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={handleDrop}
          onClick={() => {
            if (disabled) return;
            inputRef.current?.click();
          }}
          role="button"
          tabIndex={0}
          aria-disabled={disabled}
          aria-label="Upload video"
        >
          <div className="dropzone-icon" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v12" />
              <path d="m7 8 5-5 5 5" />
              <path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
            </svg>
          </div>
          <div className="dropzone-headline">
            {disabled
              ? progressPhase === "upload"
                ? "Uploading…"
                : "Transcribing…"
              : "Drop a video or audio file or click to browse"}
          </div>
          <div className="dropzone-sub">
            WhisperX runs locally — nothing leaves your machine.
          </div>
          <div className="dropzone-formats">MP4 · MOV · MKV · WebM · GIF · MP3 · WAV · M4A</div>
          <input
            ref={inputRef}
            type="file"
            accept="video/*,audio/*,image/gif"
            onChange={handleInputChange}
            disabled={disabled}
            className="start-hidden-input"
            data-testid="file-input"
            tabIndex={-1}
          />
        </div>

        {disabled && (
          <button
            className="secondary"
            onClick={cancel}
            data-testid="cancel-button"
            type="button"
          >
            Cancel
          </button>
        )}

        <div className="subs-settings" data-testid="subs-settings">
          <div className="subs-row">
            <div className="subs-row-text">
              <div className="subs-row-title">Generate subtitles</div>
              <div className="subs-row-hint">
                {generateSubs
                  ? "Whisper will transcribe after upload"
                  : "Video editor only — no transcription"}
              </div>
            </div>
            <label className="switch" data-testid="generate-subs-toggle-label" aria-label="Generate subtitles">
              <input
                type="checkbox"
                data-testid="generate-subs-toggle"
                checked={generateSubs}
                onChange={(e) => setGenerateSubs(e.target.checked)}
                disabled={disabled}
              />
              <span className="switch-track" aria-hidden>
                <span className="switch-thumb" />
              </span>
            </label>
          </div>

          {generateSubs && (
            <div className="subs-opts" data-testid="subs-options">
              <label>
                Language
                <LanguageSelect value={language} onChange={setLanguage} disabled={disabled} />
              </label>
              <label>
                Quality
                <select
                  data-testid="model-select"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={disabled}
                >
                  {QUALITY.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

type LangSelectProps = {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
};

const POPOVER_MAX_H = 320;
const POPOVER_MIN_W = 280;

function LanguageSelect({ value, onChange, disabled }: LangSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [placement, setPlacement] = useState<{ v: "down" | "up"; h: "left" | "right" }>({ v: "down", h: "left" });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    searchRef.current?.focus();
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const spaceAbove = r.top;
    const spaceRight = window.innerWidth - r.left;
    setPlacement({
      v: spaceBelow < POPOVER_MAX_H + 16 && spaceAbove > spaceBelow ? "up" : "down",
      h: spaceRight < POPOVER_MIN_W + 16 ? "right" : "left",
    });
  }, [open]);

  const selected = LANGUAGES.find((l) => l.code === value);

  const flat = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (s: string) => s.toLowerCase().includes(q);
    const filtered = q
      ? LANGUAGES.filter((l) => match(l.name) || match(l.code))
      : LANGUAGES;
    const pinned = filtered.filter((l) => PINNED_LANGUAGES.has(l.code));
    const others = filtered.filter((l) => !PINNED_LANGUAGES.has(l.code));
    return { pinned, others, all: [...pinned, ...others] };
  }, [query]);

  useEffect(() => { setActiveIdx(0); }, [query]);

  useLayoutEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open]);

  function pick(code: string) {
    onChange(code);
    setOpen(false);
    setQuery("");
  }

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, flat.all.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const lang = flat.all[activeIdx];
      if (lang) pick(lang.code);
    }
  }

  return (
    <div className="lang-select" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="lang-trigger"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        data-testid="language-select"
        data-value={value}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="lang-trigger-label">{selected?.name ?? value}</span>
        <span className="lang-chevron" aria-hidden>▾</span>
      </button>
      {open && (
        <div
          className={`lang-popover lang-popover-${placement.v} lang-popover-${placement.h}`}
          role="listbox"
          data-testid="language-popover"
        >
          <div className="lang-search-wrap">
            <input
              ref={searchRef}
              type="text"
              className="lang-search"
              placeholder="Search languages…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
              data-testid="language-search"
            />
          </div>
          <div className="lang-list" ref={listRef}>
            {flat.pinned.length > 0 && (
              <div className="lang-section">
                <span>Best quality</span>
                <span className="lang-section-hint">{flat.pinned.length}</span>
              </div>
            )}
            {flat.pinned.map((l, i) => (
              <LangOption
                key={l.code}
                code={l.code}
                name={l.name}
                selected={l.code === value}
                active={i === activeIdx}
                onSelect={pick}
                idx={i}
              />
            ))}
            {flat.others.length > 0 && (
              <div className="lang-section">
                <span>All languages</span>
                <span className="lang-section-hint">{flat.others.length}</span>
              </div>
            )}
            {flat.others.map((l, i) => {
              const idx = flat.pinned.length + i;
              return (
                <LangOption
                  key={l.code}
                  code={l.code}
                  name={l.name}
                  selected={l.code === value}
                  active={idx === activeIdx}
                  onSelect={pick}
                  idx={idx}
                />
              );
            })}
            {flat.all.length === 0 && (
              <div className="lang-empty">No matches</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function LangOption({
  code,
  name,
  selected,
  active,
  onSelect,
  idx,
}: {
  code: string;
  name: string;
  selected: boolean;
  active: boolean;
  onSelect: (code: string) => void;
  idx: number;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-idx={idx}
      className={`lang-option${selected ? " selected" : ""}${active ? " active" : ""}`}
      onClick={() => onSelect(code)}
      onMouseEnter={(e) => e.currentTarget.focus({ preventScroll: true })}
      data-testid={`language-option-${code}`}
    >
      <span className="lang-option-name">{name}</span>
      {selected && <span className="lang-option-check" aria-hidden>✓</span>}
    </button>
  );
}
