import { useEffect, useState } from "react";
import {
  deleteTranscript,
  getStorageInfo,
  getTranscript,
  listTranscripts,
  StorageInfo,
  sweepOrphansNow,
  TranscriptSummary,
  videoUrl,
} from "../api";
import { useStore } from "../store";

function fmtBytes(n: number): string {
  if (!n || !Number.isFinite(n)) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

type Props = {
  open: boolean;
  onClose: () => void;
};

function fmtDuration(d: number): string {
  if (!d || !Number.isFinite(d)) return "?";
  const m = Math.floor(d / 60);
  const s = Math.floor(d % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function fmtRelTime(ts: number): string {
  const diff = (Date.now() / 1000) - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return `${Math.floor(diff / 86400)} d ago`;
}

export function Sidebar({ open, onClose }: Props) {
  const loadProject = useStore((s) => s.loadProject);
  const currentId = useStore((s) => s.videoId);
  const reset = useStore((s) => s.reset);
  const [items, setItems] = useState<TranscriptSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [sweeping, setSweeping] = useState(false);

  async function refresh() {
    setBusy(true);
    try {
      const [list, info] = await Promise.all([listTranscripts(), getStorageInfo()]);
      setItems(list);
      setStorage(info);
    } catch (e) {
      console.warn("list transcripts:", e);
    } finally {
      setBusy(false);
    }
  }

  async function cleanOrphans() {
    setSweeping(true);
    try {
      await sweepOrphansNow();
      await refresh();
    } catch (e) {
      console.warn("sweep:", e);
    } finally {
      setSweeping(false);
    }
  }

  useEffect(() => {
    if (open) refresh();
  }, [open]);

  async function load(item: TranscriptSummary) {
    try {
      const data = await getTranscript(item.video_id);
      loadProject({
        video_id: data.video_id,
        original_filename: data.original_filename,
        duration: data.duration,
        width: data.width,
        height: data.height,
        segments: data.segments,
        url: videoUrl(data.video_id),
        is_audio_only: data.is_audio_only,
        project: data.project ?? null,
      });
      onClose();
    } catch (e) {
      console.warn("load transcript:", e);
    }
  }

  async function remove(item: TranscriptSummary, e: React.MouseEvent) {
    e.stopPropagation();
    const confirm = window.confirm(
      `Delete transcript for "${item.original_filename || item.video_id}"?\n\n` +
        `Next upload of the same video will re-transcribe from scratch.`,
    );
    if (!confirm) return;
    try {
      await deleteTranscript(item.video_id, /* drop_video */ true);
      if (currentId === item.video_id) reset();
      await refresh();
    } catch (err) {
      console.warn("delete:", err);
    }
  }

  return (
    <>
      {open && <div className="sidebar-backdrop" onClick={onClose} />}
      <aside className={`sidebar${open ? " open" : ""}`} aria-hidden={!open}>
        <div className="sidebar-header">
          <h2>Saved projects</h2>
          <button className="icon" onClick={onClose} aria-label="close">×</button>
        </div>
        {storage && (
          <div className="sidebar-storage" data-testid="sidebar-storage">
            <div className="sidebar-storage-line">
              Using {fmtBytes(storage.total_bytes)} across {storage.projects}{" "}
              project{storage.projects === 1 ? "" : "s"}
            </div>
            <button
              className="link"
              onClick={cleanOrphans}
              disabled={sweeping}
              data-testid="clean-orphans"
            >
              {sweeping ? "Cleaning…" : "Clean up orphans"}
            </button>
          </div>
        )}
        <div className="sidebar-body">
          {busy && items.length === 0 && (
            <div className="sidebar-empty">Loading…</div>
          )}
          {!busy && items.length === 0 && (
            <div className="sidebar-empty">No saved transcripts yet.</div>
          )}
          {items.map((it) => (
            <button
              key={it.video_id}
              className={`sidebar-item${it.video_id === currentId ? " active" : ""}`}
              onClick={() => load(it)}
              data-testid={`sidebar-item-${it.video_id}`}
            >
              <div className="sidebar-item-title">
                {it.original_filename || it.video_id}
              </div>
              <div className="sidebar-item-meta">
                <span>{fmtDuration(it.duration)}</span>
                <span>·</span>
                <span>{it.width}×{it.height}</span>
                <span>·</span>
                <span>{it.language ?? "?"}</span>
                <span>·</span>
                <span>{it.segments_count} seg</span>
                <span>·</span>
                <span>{fmtRelTime(it.updated_at)}</span>
              </div>
              <button
                className="sidebar-item-del"
                onClick={(e) => remove(it, e)}
                aria-label={`delete ${it.original_filename || it.video_id}`}
                title="Delete transcript + video"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M3 6h18" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  <line x1="10" y1="11" x2="10" y2="17" />
                  <line x1="14" y1="11" x2="14" y2="17" />
                </svg>
              </button>
            </button>
          ))}
        </div>
      </aside>
    </>
  );
}
