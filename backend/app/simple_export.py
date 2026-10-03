"""Fast-path exporters used when the full Chromium-driven renderer isn't needed.

Three-way dispatch lives in `main.api_export`:

- `run_stream_copy` — source as-is: `ffmpeg -c copy`. Near-instant, zero
  re-encode. Chosen when canvas is a no-op, there's no trim, no overlay, and
  the input is not audio-only.
- `run_filter_only` — canvas and/or trim but no overlay text. Still
  re-encodes video, but skips Chromium entirely.
- Full renderer lives in `renderer.render_export` (case C).
"""
from __future__ import annotations

import logging
import re
import subprocess
from pathlib import Path
from typing import Callable, Optional

from . import cancel

log = logging.getLogger(__name__)

ProgressCb = Callable[[int], None]


def _get_duration(source: Path) -> float:
    """Get media duration in seconds using ffprobe."""
    try:
        cmd = [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(source),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if result.returncode == 0 and result.stdout.strip():
            return float(result.stdout.strip())
    except Exception as e:
        log.warning("simple_export: failed to get duration for %s: %s", source, e)
    return 0.0


def _get_bitrate_params(resolution: str | None, fps: int) -> dict:
    """Return CRF / maxrate / bufsize for libx264 based on output resolution and FPS."""
    res = (resolution or "1080p").lower()
    if res in ("720p", "720"):
        return {"crf": 18, "maxrate": "8M", "bufsize": "12M"}
    if res in ("1080p", "1080"):
        if fps >= 60:
            return {"crf": 18, "maxrate": "20M", "bufsize": "30M"}
        return {"crf": 18, "maxrate": "14M", "bufsize": "20M"}
    if res in ("4k", "2160p", "2160"):
        return {"crf": 18, "maxrate": "45M", "bufsize": "60M"}
    # Fallback: treat unknown as 1080p @ 30fps
    return {"crf": 18, "maxrate": "14M", "bufsize": "20M"}

def run_stream_copy(
    source: Path,
    out: Path,
    on_progress: Optional[ProgressCb] = None,
    cancel_key: str | None = None,
) -> None:
    """Case A: canvas=source, no trim, no overlay, not audio-only."""
    out.parent.mkdir(parents=True, exist_ok=True)
    total_duration = _get_duration(source)
    cmd = [
        "ffmpeg", "-y", "-progress", "pipe:2",
        "-i", str(source),
        "-c", "copy",
        str(out),
    ]
    log.info("simple_export.stream_copy cmd=%s", " ".join(cmd))
    _run(cmd, on_progress=on_progress, total_duration=total_duration, cancel_key=cancel_key)
    if on_progress is not None:
        on_progress(100)


def run_filter_only(
    source: Path,
    out: Path,
    canvas_filter: str,
    target_w: int,
    target_h: int,
    select_expr: str | None,
    on_progress: Optional[ProgressCb] = None,
    trim_in: float = 0.0,
    trim_duration: float | None = None,
    source_volume: float = 1.0,
    extra_audio: Path | None = None,
    extra_volume: float = 1.0,
    watermark_path: Path | None = None,
    source_has_audio: bool = True,
    loop_total_duration: float | None = None,
    fps: int = 30,
    resolution: str | None = None,
    cancel_key: str | None = None,
) -> None:
    """Case B: canvas transform and/or trim, but no subtitle overlay.

    Re-encodes video through the same libx264 settings as the renderer path
    (crf=16, preset=slow, yuv420p) so outputs stay visually consistent.

    `trim_in` / `trim_duration` apply as input-seek on the source input.
    `source_volume` / `extra_audio` / `extra_volume` apply an audio mix.
    `loop_total_duration` (Coub-mode) extends the trimmed slice to that total
    by repeating both the video and the source-audio buffers via the `loop`
    /`aloop` filters; extra audio rides the master timeline as-is.
    """
    out.parent.mkdir(parents=True, exist_ok=True)
    pre = f"select='{select_expr}',setpts=N/FRAME_RATE/TB," if select_expr else ""
    chain_main = canvas_filter if canvas_filter else f"scale={target_w}:{target_h}"

    loop_active = (
        loop_total_duration is not None
        and loop_total_duration > 0
        and trim_duration is not None
        and trim_duration > 0
    )
    loop_video_suffix = ""
    loop_audio_suffix = ""
    if loop_active:
        # loop filter buffers `size` frames of the (already trimmed) input,
        # then emits them on repeat. We pin size to exactly the clip length
        # so the buffer doesn't grow unboundedly in RAM.
        frames_in_clip = max(1, int(round(trim_duration * fps)) + 2)
        loop_video_suffix = (
            f",loop=loop=-1:size={frames_in_clip}:start=0"
            f",trim=duration={loop_total_duration:.3f}"
            f",setpts=N/FRAME_RATE/TB"
        )
        # Audio loop: assume 48 kHz, +1024 sample headroom for fenceposts.
        samples_in_clip = max(1, int(round(trim_duration * 48000)) + 1024)
        loop_audio_suffix = (
            f",aloop=loop=-1:size={samples_in_clip}:start=0"
            f",atrim=duration={loop_total_duration:.3f}"
            f",asetpts=N/SR/TB"
        )

    # Video chain: process source → canvas → optionally composite watermark.
    # Watermark is 16% of the canvas width, placed bottom-right with 2%/3%
    # margin. ffmpeg's overlay filter understands W/H (main) and w/h (overlay).
    has_watermark = watermark_path is not None and watermark_path.exists()
    if has_watermark:
        wm_input_idx = 2 if extra_audio is not None else 1
        wm_w = max(1, int(target_w * 0.16))
        margin_x = max(1, int(target_w * 0.02))
        margin_y = max(1, int(target_h * 0.03))
        filter_complex = (
            f"[0:v]{pre}{chain_main}{loop_video_suffix}[vbase];"
            f"[{wm_input_idx}:v]scale={wm_w}:-1[wm];"
            # shortest=1 + repeatlast=0: overlay stops emitting frames the
            # moment the base video ends. Without this the looped PNG keeps
            # the overlay filter producing frames forever — the encoder
            # never reaches EOF and the output file grows indefinitely.
            f"[vbase][wm]overlay=W-w-{margin_x}:H-h-{margin_y}:shortest=1:repeatlast=0[v]"
        )
    else:
        filter_complex = f"[0:v]{pre}{chain_main}{loop_video_suffix}[v]"

    has_extra = extra_audio is not None
    # When source has no audio stream (e.g. screen recording, mute camera),
    # referencing [0:a] in the filter graph fails hard with "stream specifier
    # ':a' matches no streams". Branches below only touch [0:a] when the
    # source actually has an audio track.
    needs_audio_encode = (
        (has_extra)
        or (source_has_audio and abs(source_volume - 1.0) > 1e-3)
        or (source_has_audio and select_expr is not None)
    )

    if select_expr and source_has_audio:
        # silence-trim takes precedence for timing; volume/mix still apply after.
        src_audio_chain = (
            f"aselect='{select_expr}',asetpts=N/SR/TB"
            f"{loop_audio_suffix},volume={source_volume:.3f}"
        )
    elif loop_active:
        # Strip the leading comma since this is the start of the chain.
        src_audio_chain = (
            f"{loop_audio_suffix.lstrip(',')}"
            f",volume={source_volume:.3f}"
        )
    else:
        src_audio_chain = f"volume={source_volume:.3f}"
    src_audio = f"[0:a]{src_audio_chain}"

    if has_extra and source_has_audio:
        # Mix source + extra.
        filter_complex += f";{src_audio}[a0];[1:a]volume={extra_volume:.3f}[a1];[a0][a1]amix=inputs=2:duration=first:normalize=0[a]"
        audio_map = ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"]
    elif has_extra:
        # Source is silent — extra becomes the only audio stream.
        filter_complex += f";[1:a]volume={extra_volume:.3f}[a]"
        audio_map = ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"]
    elif source_has_audio and needs_audio_encode:
        filter_complex += f";{src_audio}[a]"
        audio_map = ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"]
    elif source_has_audio:
        # No processing needed — copy source audio stream through.
        audio_map = ["-map", "0:a?", "-c:a", "copy"]
    else:
        # No source audio and no extra — produce a silent MP4.
        audio_map = ["-an"]

    # Determine total duration for progress reporting
    total_duration = loop_total_duration if loop_active else (trim_duration if trim_duration and trim_duration > 0 else _get_duration(source))

    cmd = ["ffmpeg", "-y", "-progress", "pipe:2"]
    # Apply trim to the source input (and extra input) via input-seek.
    if trim_in > 0.0:
        cmd += ["-ss", f"{trim_in:.3f}"]
    if trim_duration is not None and trim_duration > 0.0:
        cmd += ["-t", f"{trim_duration:.3f}"]
    cmd += ["-i", str(source)]
    if has_extra:
        # In loop mode the extra audio drives the master timeline — do NOT
        # cap it at trim_duration. Without loop, mirror the source trim so
        # both inputs match the video clip length.
        if not loop_active and trim_duration is not None and trim_duration > 0.0:
            cmd += ["-t", f"{trim_duration:.3f}"]
        cmd += ["-i", str(extra_audio)]
    if has_watermark:
        # Single PNG, loop so overlay persists for the whole clip.
        cmd += ["-loop", "1", "-i", str(watermark_path)]
    br = _get_bitrate_params(resolution, fps)
    cmd += [
        "-filter_complex", filter_complex,
        "-map", "[v]", *audio_map,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-preset", "slow",
        "-crf", str(br["crf"]),
        "-maxrate", br["maxrate"],
        "-bufsize", br["bufsize"],
        "-r", str(fps),
    ]
    # -shortest stops encoding when the shortest input ends; otherwise the
    # looped watermark PNG (or aloop'd source) would extend the video
    # forever. In loop mode atrim/trim filters already cap the duration,
    # but -shortest is still cheap insurance.
    if has_watermark or loop_active:
        cmd += ["-shortest"]
    cmd += [str(out)]
    log.info("simple_export.filter_only cmd=%s", " ".join(cmd))
    _run(cmd, on_progress=on_progress, total_duration=total_duration, cancel_key=cancel_key)
    if on_progress is not None:
        on_progress(100)


def _run(
    cmd: list[str],
    on_progress: Optional[ProgressCb] = None,
    total_duration: float = 0.0,
    cancel_key: str | None = None,
) -> None:
    """Run ffmpeg command and report progress via on_progress callback.

    Uses ffmpeg's `-progress pipe:2` output to parse `out_time_us` and
    calculate percentage based on total_duration.
    """
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    if cancel_key is not None:
        cancel.register_proc(cancel_key, proc)

    last_pct = -1
    stderr_lines: list[str] = []

    def parse_progress(line: str):
        nonlocal last_pct
        out_time_us = 0
        line = line.strip()
        # ffmpeg progress format: key=value
        if line.startswith("out_time_us="):
            try:
                out_time_us = int(line.split("=", 1)[1])
            except ValueError:
                pass
        # Also handle the default stats format as fallback: time=HH:MM:SS.mmm
        elif "time=" in line and not line.startswith("out_time_us="):
            match = re.search(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)", line)
            if match:
                h, m, s = match.groups()
                out_time_us = int(float(h) * 3600 + float(m) * 60 + float(s)) * 1_000_000

        if total_duration > 0 and out_time_us > 0:
            current_sec = out_time_us / 1_000_000
            pct = int(min(99, (current_sec / total_duration) * 100))
            if pct >= last_pct + 1:
                last_pct = pct
                if on_progress is not None:
                    on_progress(pct)

    try:
        # Read stderr line by line to parse progress
        if proc.stderr:
            for line in proc.stderr:
                stderr_lines.append(line)
                # Check for cancellation on every line read
                if cancel_key is not None and cancel.is_cancelled(cancel_key):
                    proc.terminate()
                    try:
                        proc.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                    raise cancel.OperationCancelled("export cancelled by user")
                parse_progress(line)
        rc = proc.wait()
    finally:
        if cancel_key is not None:
            cancel.unregister_proc(cancel_key, proc)

    # A terminate() from the cancel endpoint also makes rc != 0; check the
    # flag first so a user Stop surfaces as a clean cancel, not an ffmpeg
    # failure (which callers treat as a fatal error / retry candidate).
    if cancel.is_cancelled(cancel_key):
        raise cancel.OperationCancelled("export cancelled by user")
    if rc != 0:
        err = "".join(stderr_lines)
        raise RuntimeError(f"ffmpeg failed (code {rc}):\n{err[-3000:]}")