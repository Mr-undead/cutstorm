"""Progress reporting for the fast export paths (`simple_export`).

Multiple clips are exported one request per clip, so each clip must push its
own 0→100 ramp over the WS — otherwise the "Rendering" bar sits at 0 until the
clip finishes (and the next clip resets it again).
"""
from __future__ import annotations

from pathlib import Path

from app import simple_export


class _FakeProgressStream:
    """Stand-in for ffmpeg's `-progress pipe:1` stdout."""

    def __init__(self, lines: list[str]) -> None:
        self._lines = lines

    def __iter__(self):
        return iter(self._lines)


def test_drain_progress_reports_monotonic_ramp() -> None:
    percents: list[int] = []
    stream = _FakeProgressStream(
        [
            "frame=1\n",
            "out_time_us=0\n",
            "progress=continue\n",
            "out_time_us=1000000\n",  # 1s of 5s → 20%
            "progress=continue\n",
            "out_time_us=2500000\n",  # 2.5s of 5s → 50%
            "progress=continue\n",
            "out_time_us=5000000\n",  # complete — capped at 99 until ffmpeg exits
            "out_time_us=90000000\n",  # overshoot stays capped
            "progress=end\n",
        ]
    )
    simple_export._drain_progress(stream, 5.0, percents.append)
    assert percents == [0, 20, 50, 99]


def test_drain_progress_ignores_garbage_lines() -> None:
    percents: list[int] = []
    stream = _FakeProgressStream(
        ["out_time_us=not-a-number\n", "speed=1.1x\n", "out_time_ms=2000000\n"]
    )
    simple_export._drain_progress(stream, 4.0, percents.append)
    assert percents == [50]


def test_filter_only_reports_intermediate_progress(
    sample_video: Path, tmp_path: Path
) -> None:
    percents: list[int] = []
    simple_export.run_filter_only(
        source=sample_video,
        out=tmp_path / "out.mp4",
        canvas_filter="",
        target_w=320,
        target_h=240,
        select_expr=None,
        on_progress=percents.append,
        trim_in=0.5,
        trim_duration=4.0,
        total_duration=4.0,
    )
    assert percents[-1] == 100
    assert percents == sorted(percents)
    assert any(0 < p < 100 for p in percents), percents
