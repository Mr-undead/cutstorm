from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import main as app_main
from app.main import app


def _hf_cache(root: Path) -> Path:
    """Recreate the on-disk layout of a Hugging Face model cache: one physical
    copy under ``blobs/`` exposed from two ``snapshots/<revision>/`` entries via
    symlinks. Returns the blob path."""
    repo = root / "models--org--name"
    blob = repo / "blobs" / ("a" * 40)
    blob.parent.mkdir(parents=True)
    blob.write_bytes(b"x" * 4096)
    for revision in ("deadbeef", "cafebabe"):
        snap = repo / "snapshots" / revision
        snap.mkdir(parents=True)
        (snap / "model.bin").symlink_to(blob)
    return blob


@pytest.fixture
def storage_dirs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path, Path]:
    uploads = tmp_path / "uploads"
    outputs = tmp_path / "outputs"
    models = tmp_path / "models"
    for d in (uploads, outputs, models):
        d.mkdir()
    monkeypatch.setattr(app_main, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(app_main, "OUTPUTS_DIR", outputs)
    monkeypatch.setattr(app_main, "MODELS_DIR", models)
    return uploads, outputs, models


# ---------- _dir_size_bytes ----------


def test_dir_size_sums_nested_regular_files(tmp_path: Path) -> None:
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "one.bin").write_bytes(b"1" * 100)
    (tmp_path / "a" / "b").mkdir()
    (tmp_path / "a" / "b" / "two.bin").write_bytes(b"2" * 250)
    assert app_main._dir_size_bytes(tmp_path) == 350


def test_dir_size_counts_symlinked_files_once(tmp_path: Path) -> None:
    """Regression: HF caches expose each blob from snapshots/ via symlinks; the
    same bytes must not be charged once per revision (and once for the blob)."""
    blob = _hf_cache(tmp_path)
    assert app_main._dir_size_bytes(tmp_path) == blob.stat().st_size == 4096


def test_dir_size_does_not_follow_symlinks_outside_tree(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "big.bin").write_bytes(b"b" * 5000)
    tree = tmp_path / "tree"
    tree.mkdir()
    (tree / "small.bin").write_bytes(b"s" * 10)
    (tree / "link.bin").symlink_to(outside / "big.bin")
    assert app_main._dir_size_bytes(tree) == 10


def test_dir_size_counts_hard_links_once(tmp_path: Path) -> None:
    first = tmp_path / "one.bin"
    first.write_bytes(b"x" * 1024)
    try:
        os.link(first, tmp_path / "two.bin")
    except OSError:  # pragma: no cover — filesystem without hard-link support
        pytest.skip("hard links not supported on this filesystem")
    assert app_main._dir_size_bytes(tmp_path) == 1024


def test_dir_size_skips_dangling_symlinks(tmp_path: Path) -> None:
    (tmp_path / "real.bin").write_bytes(b"z" * 10)
    (tmp_path / "dangling.bin").symlink_to(tmp_path / "missing.bin")
    assert app_main._dir_size_bytes(tmp_path) == 10


def test_dir_size_missing_directory_is_zero(tmp_path: Path) -> None:
    assert app_main._dir_size_bytes(tmp_path / "nope") == 0


# ---------- /api/storage ----------


def test_storage_endpoint_reports_real_usage(storage_dirs: tuple[Path, Path, Path]) -> None:
    uploads, outputs, models = storage_dirs
    (uploads / "aaaaaaaaaaaaaaaa.mp4").write_bytes(b"u" * 1000)
    (uploads / "aaaaaaaaaaaaaaaa.json").write_text(json.dumps({"video_id": "aaaaaaaaaaaaaaaa"}))
    (outputs / "out.mp4").write_bytes(b"o" * 2000)
    blob = _hf_cache(models)

    client = TestClient(app)
    r = client.get("/api/storage")
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {
        "uploads_bytes",
        "outputs_bytes",
        "models_bytes",
        "total_bytes",
        "projects",
    }
    # Every regular file in uploads/ counts, so the meta json adds to the media.
    meta_size = len((uploads / "aaaaaaaaaaaaaaaa.json").read_bytes())
    assert body["uploads_bytes"] == 1000 + meta_size
    assert body["outputs_bytes"] == 2000
    assert body["models_bytes"] == blob.stat().st_size
    assert body["total_bytes"] == body["uploads_bytes"] + body["outputs_bytes"] + body["models_bytes"]
    assert body["projects"] == 1
