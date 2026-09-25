"""Fast-path exporters used when the full Chromium-driven renderer isn't needed.

Three-way dispatch lives in `main.api_export`:

- `run_stream_copy` — source as-is: `ffmpeg -c copy`. Near-instant, zero
  re-encode. Chosen when canvas is a no-op, there's no trim, no overlay, and
  the input is not audio-only.
- `run_filter_only` — canvas and/or trim but no overlay text. Still
  re-encodes video, but skips Chromium entirely.
- Full renderer lives in `renderer.render_export` (case C).

Both fast paths stream ffmpeg's `-progress pipe:1` output so the caller's
`on_progress` callback gets a real 0→99 ramp (then 100 on success). Pass
`total_duration` (the expected output length, in seconds) to enable it;
without it the callback only fires once with 100 at the end.
"""
from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path
from typing import Callable, Optional

log = logging.getLogger(__name__)

ProgressCb = Callable[[int], None]


def run_stream_copy(
    source: Path,
    out: Path,
    on_progress: Optional[ProgressCb] = None,
    total_duration: float | None = None,
) -> None:
    """Case A: canvas=source, no trim, no overlay, not audio-only."""
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-nostats", "-loglevel", "error",
        "-progress", "pipe:1", "-stats_period", "0.2",
        "-i", str(source),
        "-c", "copy",
        str(out),
    ]
    log.info("simple_export.stream_copy cmd=%s", " ".join(cmd))
    _run(cmd, total_duration=total_duration, on_progress=on_progress)
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
    total_duration: float | None = None,
    fps: int = 30,
) -> None:
    """Case B: canvas transform and/or trim, but no subtitle overlay.

    Re-encodes video through the same libx264 settings as the renderer path
    (crf=16, preset=slow, yuv420p) so outputs stay visually consistent.

    `trim_in` / `trim_duration` apply as input-seek on the source input.
    `source_volume` / `extra_audio` / `extra_volume` apply an audio mix.
    `loop_total_duration` (Coub-mode) extends the trimmed slice to that total
    by repeating both the video and the source-audio buffers via the `loop`
    /`aloop` filters; extra audio rides the master timeline as-is.
    `total_duration` is the expected output length (seconds) used to turn
    ffmpeg's `-progress` stream into a 0→99 percent ramp.
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

    cmd = ["ffmpeg", "-y", "-nostats", "-loglevel", "error",
           "-progress", "pipe:1", "-stats_period", "0.2"]
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
    cmd += [
        "-filter_complex", filter_complex,
        "-map", "[v]", *audio_map,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-preset", "slow",
        "-crf", "16",
    ]
    # -shortest stops encoding when the shortest input ends; otherwise the
    # looped watermark PNG (or aloop'd source) would extend the video
    # forever. In loop mode atrim/trim filters already cap the duration,
    # but -shortest is still cheap insurance.
    if has_watermark or loop_active:
        cmd += ["-shortest"]
    cmd += [str(out)]
    log.info("simple_export.filter_only cmd=%s", " ".join(cmd))
    _run(cmd, total_duration=total_duration, on_progress=on_progress)
    if on_progress is not None:
        on_progress(100)


def _drain_progress(
    stream,
    total_duration: float,
    on_progress: ProgressCb,
) -> None:
    """Turn ffmpeg's `-progress pipe:1` lines into a monotonic 0–99 ramp.

    ffmpeg writes `out_time_us=` / `out_time_ms=` (both in microseconds) on
    every stats tick and `progress=end` when the muxer is done. Percent is
    capped at 99 here; the caller reports the final 100 once ffmpeg exits
    successfully, mirroring the renderer path (`renderer._capture_frames`).
    """
    last = -1
    for raw in stream:
        line = raw.strip()
        if not (line.startswith("out_time_us=") or line.startswith("out_time_ms=")):
            continue
        try:
            us = int(line.split("=", 1)[1])
        except ValueError:
            continue
        if us < 0:
            continue
        pct = max(0, min(99, int(us / 1_000_000 / total_duration * 100)))
        if pct > last:
            on_progress(pct)
            last = pct


def _run(
    cmd: list[str],
    total_duration: float | None = None,
    on_progress: Optional[ProgressCb] = None,
) -> None:
    """Run ffmpeg, draining `-progress pipe:1` when duration + callback are known.

    stderr still goes to a temporary file (never a PIPE) so ffmpeg can't
    deadlock on a full pipe buffer; stdout is only piped when we actually
    need the progress stream.
    """
    want_progress = (
        on_progress is not None and total_duration is not None and total_duration > 0
    )
    stderr_file = tempfile.TemporaryFile(mode="w+b")
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE if want_progress else subprocess.DEVNULL,
            stderr=stderr_file,
            text=want_progress,
        )
        if want_progress:
            assert proc.stdout is not None and on_progress is not None
            _drain_progress(proc.stdout, float(total_duration), on_progress)
        rc = proc.wait()
        stderr_file.seek(0)
        err = stderr_file.read().decode("utf-8", errors="replace")[-3000:]
    finally:
        stderr_file.close()
    if rc != 0:
        raise RuntimeError(f"ffmpeg failed (code {rc}):\n{err}")
