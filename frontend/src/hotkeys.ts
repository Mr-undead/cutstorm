import { useEffect } from "react";
import { useStore } from "./store";

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    // Range/checkbox/radio inputs don't accept text; they don't need the
    // hotkey bypass — and blocking Space here breaks playPause when a slider
    // happens to be focused (e.g. the volume controls in the timeline).
    const type = (el as HTMLInputElement).type;
    return type !== "range" && type !== "checkbox" && type !== "radio" && type !== "file";
  }
  if (el.isContentEditable) return true;
  return false;
}

export function useHotkeys(): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const editing = isEditable(e.target);
      const mod = e.metaKey || e.ctrlKey;
      // If focus is on the <video> element itself, let Chromium's native
      // controls handle Space/arrows — otherwise both the browser's built-in
      // handler and our playPause() fire in the same tick, and the double
      // toggle ends up pausing what we just started.
      const onVideo = (e.target as HTMLElement | null)?.tagName === "VIDEO";

      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        const t = useStore.temporal.getState();
        if (e.shiftKey) t.redo();
        else t.undo();
        return;
      }

      if (editing) return;

      const { playPause, nudge, splitAtCurrent, deleteCurrent, setDraftTrimRange } = useStore.getState();
      switch (e.key) {
        case "i":
        case "I":
          e.preventDefault();
          setDraftTrimRange({ in_sec: useStore.getState().currentTime });
          return;
        case "o":
        case "O":
          e.preventDefault();
          setDraftTrimRange({ out_sec: useStore.getState().currentTime });
          return;
        case " ":
          if (onVideo) return;  // let native video controls toggle play
          e.preventDefault();
          playPause();
          return;
        case "j":
        case "J":
          e.preventDefault();
          nudge(-5);
          return;
        case "k":
        case "K":
          if (onVideo) return;
          e.preventDefault();
          playPause();
          return;
        case "l":
        case "L":
          e.preventDefault();
          nudge(5);
          return;
        case "ArrowLeft":
          if (onVideo) return;
          e.preventDefault();
          nudge(-1 / 30);
          return;
        case "ArrowRight":
          if (onVideo) return;
          e.preventDefault();
          nudge(1 / 30);
          return;
        case "Enter":
          e.preventDefault();
          splitAtCurrent();
          return;
        case "Backspace":
        case "Delete":
          e.preventDefault();
          deleteCurrent();
          return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
