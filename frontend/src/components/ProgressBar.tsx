import { useStore } from "../store";

const PHASE_LABEL: Record<string, string> = {
  upload: "Uploading",
  transcribe: "Transcribing",
  align: "Aligning words",
  encode: "Rendering",
};

export function ProgressBar() {
  const phase = useStore((s) => s.progressPhase);
  const percent = useStore((s) => s.progressPercent);

  if (phase === "idle" || phase === "done") return null;

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
      <div className="progress-bar-track">
        <div className="progress-bar-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
