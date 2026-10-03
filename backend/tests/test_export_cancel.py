"""Cancellation of a running export (Stop button on the progress bar).

Covers three layers:
  1. `app.cancel` registry — flag flip + process termination + exception type.
  2. `simple_export._run` — a terminated ffmpeg surfaces as `OperationCancelled`
     (and deliberately NOT as `RuntimeError`, which would make the dispatcher
     fall back to a full filter-only re-encode instead of stopping).
  3. `api_export` — returns HTTP 499, deletes the partial output and never
     leaves a stale "cancelled" flag behind for the next export of that job.

The `/api/export/{job_id}/cancel` endpoint is exercised directly (registry
pre-seeded) and indirectly (a worker that cancels itself mid-render), which
keeps the tests single-threaded and deterministic.
"""
from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import cancel as cancel_mod
from app import main as app_main
from app import simple_export
from app.main import app, _meta_path
from app.transcribe import ProbeInfo


VIDEO_ID = "a1b2c3d4e5f60718"
JOB_ID = "job-export-cancel-1"
CANCEL_KEY = f"export:{JOB_ID}"

SOURCE_CANVAS = {
    "mode": "preset",
    "preset": "source",
    "crop_anchor": "center",
    "custom": {"x_pct": 0, "y_pct": 0, "w_pct": 100, "h_pct": 100},
    "bg_color": "#000000",
}


# --------------------------------------------------------------------------- #
# fixtures / helpers
# --------------------------------------------------------------------------- #


@pytest.fixture(autouse=True)
def clean_registry():
    """Never let a flag leak between tests — the registry is process-global."""
    yield
    for key in (CANCEL_KEY, f"export:{VIDEO_ID}:None", "export:unit", "export:run"):
        cancel_mod.clear(key)


@pytest.fixture()
def dirs(tmp_path, monkeypatch):
    uploads = tmp_path / "uploads"
    outputs = tmp_path / "outputs"
    uploads.mkdir()
    outputs.mkdir()
    monkeypatch.setattr(app_main, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(app_main, "OUTPUTS_DIR", outputs)
    return uploads, outputs


@pytest.fixture()
def client(dirs, monkeypatch):
    monkeypatch.setattr(
        "app.main.probe",
        lambda path: ProbeInfo(duration=5.0, width=1280, height=720, fps=30.0, is_audio_only=False),
    )
    return TestClient(app)


def _seed_video(video_id: str = VIDEO_ID) -> Path:
    # Read UPLOADS_DIR off the module (not the import-time binding) so the
    # `dirs` fixture's monkeypatch is honoured.
    uploads = app_main.UPLOADS_DIR
    uploads.mkdir(parents=True, exist_ok=True)
    path = uploads / f"{video_id}.mp4"
    path.write_bytes(b"\x00" * 32)  # placeholder — probe is monkeypatched
    _meta_path(video_id).write_text(json.dumps({
        "video_id": video_id,
        "duration": 5.0,
        "width": 1280,
        "height": 720,
        "language": "en",
        "segments": [],
        "is_audio_only": False,
    }))
    return path


def _post_export(client: TestClient, **extra):
    body = {
        "video_id": VIDEO_ID,
        "segments": [],
        "style": {"mode": "phrase"},
        "position": {"x_pct": 10.0, "y_pct": 80.0},
        "size": {"w_pct": 80.0, "h_pct": 15.0},
        "trim_silences": False,
        "silence_threshold_sec": 0.4,
        "silence_padding_sec": 0.08,
        "canvas": SOURCE_CANVAS,
        "watermark": False,
    }
    body.update(extra)
    return client.post(f"/api/export?job_id={JOB_ID}", json=body)


def _output_mp4() -> Path:
    return app_main.OUTPUTS_DIR / f"{VIDEO_ID}.mp4"


# --------------------------------------------------------------------------- #
# 1. registry
# --------------------------------------------------------------------------- #


def test_operation_cancelled_is_not_a_runtime_error() -> None:
    """`do_render` catches RuntimeError to fall back from stream-copy to
    filter-only. Cancellation must therefore NOT be a RuntimeError, or pressing
    Stop would silently start a brand-new render."""
    assert issubclass(cancel_mod.OperationCancelled, Exception)
    assert not issubclass(cancel_mod.OperationCancelled, RuntimeError)


def test_request_cancel_flips_flag_and_kills_process() -> None:
    cancel_mod.new_flag("export:unit")
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    cancel_mod.register_proc("export:unit", proc)
    try:
        assert cancel_mod.is_cancelled("export:unit") is False
        assert cancel_mod.request_cancel("export:unit") is True
        proc.wait(timeout=10)
        assert proc.returncode != 0
        assert cancel_mod.is_cancelled("export:unit") is True
    finally:
        if proc.poll() is None:
            proc.kill()
        cancel_mod.unregister_proc("export:unit", proc)


def test_request_cancel_on_unknown_key_is_a_noop() -> None:
    assert cancel_mod.request_cancel("export:does-not-exist") is False


def test_register_proc_after_cancel_kills_immediately() -> None:
    """The Stop click can land while the process is still being spawned."""
    cancel_mod.new_flag("export:unit")
    cancel_mod.request_cancel("export:unit")
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    cancel_mod.register_proc("export:unit", proc)
    try:
        proc.wait(timeout=10)
        assert proc.returncode != 0
    finally:
        if proc.poll() is None:
            proc.kill()
        cancel_mod.unregister_proc("export:unit", proc)


# --------------------------------------------------------------------------- #
# 2. simple_export
# --------------------------------------------------------------------------- #


def test_run_raises_operation_cancelled_when_stopped() -> None:
    cancel_mod.new_flag("export:run")
    captured: list[BaseException] = []

    def worker() -> None:
        try:
            simple_export._run(
                [sys.executable, "-c", "import time; time.sleep(30)"],
                cancel_key="export:run",
            )
        except BaseException as exc:  # noqa: BLE001 — asserted below
            captured.append(exc)

    thread = threading.Thread(target=worker)
    thread.start()
    # Let Popen spawn + register itself, then press Stop.
    time.sleep(0.5)
    cancel_mod.request_cancel("export:run")
    thread.join(timeout=10)

    assert not thread.is_alive()
    assert len(captured) == 1
    assert isinstance(captured[0], cancel_mod.OperationCancelled)


# --------------------------------------------------------------------------- #
# 3. cancel endpoint
# --------------------------------------------------------------------------- #


def test_cancel_endpoint_flags_registered_export(client) -> None:
    cancel_mod.new_flag(CANCEL_KEY)
    try:
        r = client.post(f"/api/export/{JOB_ID}/cancel")
        assert r.status_code == 200
        assert r.json() == {"ok": True, "cancelled": True}
        assert cancel_mod.is_cancelled(CANCEL_KEY) is True
    finally:
        cancel_mod.clear(CANCEL_KEY)


def test_cancel_endpoint_noop_without_live_export(client) -> None:
    r = client.post("/api/export/not-a-running-job/cancel")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "cancelled": False}


# --------------------------------------------------------------------------- #
# 4. api_export integration
# --------------------------------------------------------------------------- #


def test_stream_copy_cancel_returns_499_and_removes_output(client, monkeypatch) -> None:
    """Stop during the stream-copy path → 499, no filter-only fallback, and the
    half-written file is deleted."""
    _seed_video()
    fallback_calls: list[dict] = []

    def stream_copy_spy(**kw):
        out = Path(kw["out"])
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"partial-mp4")
        # Simulate the user pressing Stop while ffmpeg runs: the flag is flipped
        # and simple_export._run would then raise OperationCancelled.
        assert kw["cancel_key"] == CANCEL_KEY
        cancel_mod.request_cancel(kw["cancel_key"])
        raise cancel_mod.OperationCancelled("export cancelled by user")

    def filter_only_spy(**kw):  # pragma: no cover — must never be reached
        fallback_calls.append(kw)

    monkeypatch.setattr("app.simple_export.run_stream_copy", stream_copy_spy)
    monkeypatch.setattr("app.simple_export.run_filter_only", filter_only_spy)

    r = _post_export(client, resolution="720p", fps=30)

    assert r.status_code == 499, r.text
    assert r.json()["detail"] == "export cancelled"
    assert fallback_calls == []
    assert not _output_mp4().exists()
    # The flag must be released, otherwise the next export of this job would be
    # insta-cancelled by a stale flag.
    assert cancel_mod.flag_for(CANCEL_KEY) is None


def test_renderer_cancel_returns_499_and_removes_output(client, monkeypatch) -> None:
    _seed_video()

    def render_spy(**kw):
        out = Path(kw["out"])
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"partial-render")
        assert kw["cancel_key"] == CANCEL_KEY
        cancel_mod.request_cancel(kw["cancel_key"])
        raise cancel_mod.OperationCancelled("export cancelled by user")

    monkeypatch.setattr("app.renderer.render_export", render_spy)

    r = _post_export(
        client,
        segments=[{
            "start": 0.0, "end": 1.0, "text": "hello",
            "words": [{"start": 0.0, "end": 1.0, "text": "hello"}],
        }],
    )

    assert r.status_code == 499, r.text
    assert not _output_mp4().exists()
    assert cancel_mod.flag_for(CANCEL_KEY) is None


def test_gif_cancel_returns_499(client, monkeypatch) -> None:
    """Stop during the palette-gen GIF pass is reported as a cancel, not as a
    generic 500 gif-encode failure."""
    _seed_video()

    def stream_copy_spy(**kw):
        out = Path(kw["out"])
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"fake-mp4-stream-copy")

    def encode_gif_spy(src_mp4, dst_gif, quality, cancel_key=None):
        cancel_mod.request_cancel(cancel_key)
        # A terminated ffmpeg exits non-zero → CalledProcessError.
        raise subprocess.CalledProcessError(255, ["ffmpeg"])

    monkeypatch.setattr("app.simple_export.run_stream_copy", stream_copy_spy)
    monkeypatch.setattr(app_main, "_encode_gif", encode_gif_spy)

    r = _post_export(client, format="gif", gif_quality="low", resolution="720p", fps=30)

    assert r.status_code == 499, r.text
    assert not _output_mp4().exists()
    assert not (app_main.OUTPUTS_DIR / f"{VIDEO_ID}.gif").exists()
    assert cancel_mod.flag_for(CANCEL_KEY) is None


def test_real_ffmpeg_failure_still_reports_500(client, monkeypatch) -> None:
    """Regression guard: a genuine ffmpeg error must not be mistaken for a
    cancel (that would swallow real failures as a silent 499)."""
    _seed_video()

    def fail_spy(**kw):
        raise RuntimeError("ffmpeg failed (code 1): boom")

    monkeypatch.setattr("app.simple_export.run_stream_copy", fail_spy)
    monkeypatch.setattr("app.simple_export.run_filter_only", fail_spy)

    r = _post_export(client, resolution="720p", fps=30)

    assert r.status_code == 500, r.text
    assert "export failed" in r.json()["detail"]
    assert cancel_mod.flag_for(CANCEL_KEY) is None


def test_export_succeeds_and_clears_flag(client, monkeypatch) -> None:
    _seed_video()

    def stream_copy_spy(**kw):
        out = Path(kw["out"])
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"fake-mp4-stream-copy")

    monkeypatch.setattr("app.simple_export.run_stream_copy", stream_copy_spy)

    r = _post_export(client, resolution="720p", fps=30)

    assert r.status_code == 200, r.text
    assert _output_mp4().exists()
    assert cancel_mod.flag_for(CANCEL_KEY) is None
