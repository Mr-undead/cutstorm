from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app, _meta_path, _video_path, UPLOADS_DIR
from app.transcribe import ProbeInfo


VIDEO_ID = "a1b2c3d4e5f60718"
AUDIO_ID = "b1b2c3d4e5f60718"


def _seed_video(video_id: str, width: int, height: int, duration: float = 5.0,
                is_audio_only: bool = False) -> Path:
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    ext = "mp3" if is_audio_only else "mp4"
    path = UPLOADS_DIR / f"{video_id}.{ext}"
    path.write_bytes(b"\x00" * 32)  # placeholder — real probe is monkeypatched
    meta = {
        "video_id": video_id,
        "duration": duration,
        "width": width,
        "height": height,
        "language": "en",
        "segments": [],
        "is_audio_only": is_audio_only,
        "_cache_key": "__dispatch__",
    }
    _meta_path(video_id).write_text(json.dumps(meta))
    return path


def _clear_seed(video_id: str) -> None:
    for ext in ("mp4", "mp3", "wav"):
        p = UPLOADS_DIR / f"{video_id}.{ext}"
        if p.exists():
            p.unlink()
    meta = _meta_path(video_id)
    if meta.exists():
        meta.unlink()


@pytest.fixture()
def client(monkeypatch):
    def fake_probe(path: Path) -> ProbeInfo:
        name = Path(path).name
        if name.startswith(AUDIO_ID):
            return ProbeInfo(duration=5.0, width=0, height=0, is_audio_only=True)
        # Default 1280x720 for video
        return ProbeInfo(duration=5.0, width=1280, height=720, fps=30.0, is_audio_only=False)

    # Patch probe everywhere it's imported.
    monkeypatch.setattr("app.main.probe", fake_probe)
    yield TestClient(app)


@pytest.fixture()
def spies(monkeypatch):
    hit: dict[str, dict] = {}

    def stream_copy_spy(**kw):
        hit["stream_copy"] = kw
        out = Path(kw["out"])
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"fake-mp4-stream-copy")

    def filter_only_spy(**kw):
        hit["filter_only"] = kw
        out = Path(kw["out"])
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"fake-mp4-filter-only")

    def render_spy(**kw):
        hit["render"] = kw
        out = Path(kw["out"])
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"fake-mp4-renderer")

    monkeypatch.setattr("app.simple_export.run_stream_copy", stream_copy_spy)
    monkeypatch.setattr("app.simple_export.run_filter_only", filter_only_spy)
    monkeypatch.setattr("app.renderer.render_export", render_spy)
    yield hit


def _post_export(client: TestClient, *, video_id: str, canvas: dict,
                  segments: list[dict] | None = None, trim: bool = False,
                  watermark: bool = False, resolution: str | None = None,
                  fps: int | None = None) -> dict:
    body = {
        "video_id": video_id,
        "segments": segments or [],
        "style": {"mode": "phrase"},
        "position": {"x_pct": 10.0, "y_pct": 80.0},
        "size": {"w_pct": 80.0, "h_pct": 15.0},
        "trim_silences": trim,
        "silence_threshold_sec": 0.4,
        "silence_padding_sec": 0.08,
        "canvas": canvas,
        # Dispatch tests exercise the routing logic; watermark forces
        # filter_only so keep it off here unless a specific test asks.
        "watermark": watermark,
    }
    if resolution is not None:
        body["resolution"] = resolution
    if fps is not None:
        body["fps"] = fps
    r = client.post("/api/export", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def test_case_a_stream_copy_when_noop(client, spies):
    _clear_seed(VIDEO_ID)
    _seed_video(VIDEO_ID, 1280, 720)
    try:
        _post_export(
            client,
            video_id=VIDEO_ID,
            canvas={"mode": "preset", "preset": "source", "crop_anchor": "center",
                    "custom": {"x_pct": 0, "y_pct": 0, "w_pct": 100, "h_pct": 100},
                    "bg_color": "#000000"},
            resolution="720p",
        )
        assert "stream_copy" in spies
        assert "filter_only" not in spies
        assert "render" not in spies
    finally:
        _clear_seed(VIDEO_ID)


def test_case_b_filter_only_when_canvas_transform_no_overlay(client, spies):
    _clear_seed(VIDEO_ID)
    _seed_video(VIDEO_ID, 1280, 720)
    try:
        _post_export(
            client,
            video_id=VIDEO_ID,
            canvas={"mode": "preset", "preset": "9:16", "crop_anchor": "center",
                    "custom": {"x_pct": 0, "y_pct": 0, "w_pct": 100, "h_pct": 100},
                    "bg_color": "#000000"},
        )
        assert "filter_only" in spies
        assert "stream_copy" not in spies
        assert "render" not in spies
    finally:
        _clear_seed(VIDEO_ID)


def test_case_b_filter_only_when_trim_no_overlay(client, spies):
    _clear_seed(VIDEO_ID)
    _seed_video(VIDEO_ID, 1280, 720)
    try:
        # trim=true with no words → keeps full duration, but keeps is not None → trim_active=True.
        _post_export(
            client,
            video_id=VIDEO_ID,
            canvas={"mode": "preset", "preset": "source", "crop_anchor": "center",
                    "custom": {"x_pct": 0, "y_pct": 0, "w_pct": 100, "h_pct": 100},
                    "bg_color": "#000000"},
            trim=True,
        )
        assert "filter_only" in spies
        assert "stream_copy" not in spies
        assert "render" not in spies
    finally:
        _clear_seed(VIDEO_ID)


def test_case_c_renderer_when_overlay(client, spies):
    _clear_seed(VIDEO_ID)
    _seed_video(VIDEO_ID, 1280, 720)
    try:
        segs = [{
            "start": 0.0, "end": 1.0, "text": "hello",
            "words": [{"start": 0.0, "end": 1.0, "text": "hello"}],
        }]
        _post_export(
            client,
            video_id=VIDEO_ID,
            canvas={"mode": "preset", "preset": "source", "crop_anchor": "center",
                    "custom": {"x_pct": 0, "y_pct": 0, "w_pct": 100, "h_pct": 100},
                    "bg_color": "#000000"},
            segments=segs,
        )
        assert "render" in spies
        assert "stream_copy" not in spies
        assert "filter_only" not in spies
    finally:
        _clear_seed(VIDEO_ID)


def test_case_c_renderer_when_audio_only(client, spies):
    _clear_seed(AUDIO_ID)
    _seed_video(AUDIO_ID, 0, 0, is_audio_only=True)
    try:
        # Audio-only + empty segments still must go to renderer (synthetic video needed).
        _post_export(
            client,
            video_id=AUDIO_ID,
            canvas={"mode": "preset", "preset": "source", "crop_anchor": "center",
                    "custom": {"x_pct": 0, "y_pct": 0, "w_pct": 100, "h_pct": 100},
                    "bg_color": "#000000"},
        )
        assert "render" in spies
        assert "stream_copy" not in spies
        assert "filter_only" not in spies
    finally:
        _clear_seed(AUDIO_ID)


def test_blank_text_segments_treated_as_no_overlay(client, spies):
    _clear_seed(VIDEO_ID)
    _seed_video(VIDEO_ID, 1280, 720)
    try:
        # Segments exist but text is only whitespace → no overlay text to render.
        segs = [{"start": 0.0, "end": 1.0, "text": "   ", "words": []}]
        _post_export(
            client,
            video_id=VIDEO_ID,
            canvas={"mode": "preset", "preset": "source", "crop_anchor": "center",
                    "custom": {"x_pct": 0, "y_pct": 0, "w_pct": 100, "h_pct": 100},
                    "bg_color": "#000000"},
            segments=segs,
            resolution="720p",
        )
        assert "stream_copy" in spies  # whitespace-only segments → no overlay → Case A
        assert "render" not in spies
    finally:
        _clear_seed(VIDEO_ID)


def test_case_c_renderer_when_overlay_plus_canvas(client, spies):
    _clear_seed(VIDEO_ID)
    _seed_video(VIDEO_ID, 1280, 720)
    try:
        segs = [{"start": 0.0, "end": 1.0, "text": "hi", "words": []}]
        _post_export(
            client,
            video_id=VIDEO_ID,
            canvas={"mode": "preset", "preset": "9:16", "crop_anchor": "center",
                    "custom": {"x_pct": 0, "y_pct": 0, "w_pct": 100, "h_pct": 100},
                    "bg_color": "#000000"},
            segments=segs,
        )
        assert "render" in spies
        assert "stream_copy" not in spies
        assert "filter_only" not in spies
    finally:
        _clear_seed(VIDEO_ID)
