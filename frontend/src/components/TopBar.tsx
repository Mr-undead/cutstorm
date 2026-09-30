import logoUrl from "../assets/lockup.png";
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
  onOpenExport: () => void;
};

export function TopBar({ onOpenSidebar, onOpenExport }: TopBarProps) {
  const videoId = useStore((s) => s.videoId);
  const duration = useStore((s) => s.duration);
  const videoW = useStore((s) => s.videoW);
  const videoH = useStore((s) => s.videoH);
  const segments = useStore((s) => s.segments);
  const busy = useStore((s) => s.busy);
  const newProject = useStore((s) => s.newProject);

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
            <button
              className="primary"
              onClick={onOpenExport}
              disabled={busy !== "idle"}
              data-testid="export-button"
            >
              {busy === "exporting" ? "Exporting…" : "Export"}
            </button>

          </>
        )}
      </div>
    </header>
  );
}
