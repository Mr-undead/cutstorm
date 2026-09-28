"""Cross-thread cancellation registry for long-running operations.

Every cancellable operation registers a mutable flag dict (checked
cooperatively between steps) and — when a subprocess is involved — its
Popen handle, so a `/cancel` endpoint can flip the flag AND terminate the
process from another thread. Mirrors the existing `_transcribe_tasks` /
`_fetch_cancel_events` pattern, but shared so the export pipeline (ffmpeg
stream-copy, filter-only and the Chromium renderer) can use it too.

`OperationCancelled` deliberately subclasses `Exception`, NOT `RuntimeError`:
the export dispatcher in `main.api_export` catches `RuntimeError` around the
stream-copy path to fall back to filter-only. If cancellation were a
RuntimeError, pressing Stop on a stream-copy would silently re-run the whole
export through filter-only instead of stopping.
"""
from __future__ import annotations

import logging
import subprocess
import threading

log = logging.getLogger(__name__)


class OperationCancelled(Exception):
    """Raised by export workers when the user pressed Stop."""


_lock = threading.Lock()
_flags: dict[str, dict] = {}
_procs: dict[str, subprocess.Popen] = {}


def new_flag(key: str) -> dict:
    """Register a fresh cancel flag for `key` and return it. Callers poll
    `flag["v"]` between steps (filesystem/thread-safe: dict item swap)."""
    flag = {"v": False}
    with _lock:
        _flags[key] = flag
    return flag


def flag_for(key: str) -> dict | None:
    with _lock:
        return _flags.get(key)


def is_cancelled(key: str | None) -> bool:
    if key is None:
        return False
    flag = flag_for(key)
    return bool(flag is not None and flag["v"])


def register_proc(key: str, proc: subprocess.Popen) -> None:
    """Track a running subprocess for `key`. If cancel already arrived while
    the process was being spawned, terminate it immediately so the request
    can't race past the user's Stop."""
    with _lock:
        _procs[key] = proc
        flag = _flags.get(key)
    if flag is not None and flag["v"]:
        _terminate(proc)


def unregister_proc(key: str, proc: subprocess.Popen) -> None:
    with _lock:
        if _procs.get(key) is proc:
            _procs.pop(key, None)


def clear(key: str) -> None:
    with _lock:
        _flags.pop(key, None)
        _procs.pop(key, None)


def request_cancel(key: str) -> bool:
    """Flip the flag and terminate the in-flight subprocess (if any).
    Returns True when something was actually cancelled."""
    with _lock:
        flag = _flags.get(key)
        proc = _procs.get(key)
    cancelled = False
    if flag is not None:
        flag["v"] = True
        cancelled = True
    if proc is not None and proc.poll() is None:
        _terminate(proc)
        cancelled = True
    return cancelled


def _terminate(proc: subprocess.Popen) -> None:
    try:
        proc.terminate()  # SIGTERM → ffmpeg flushes and exits
    except Exception:
        return
    try:
        proc.wait(timeout=3)
    except Exception:
        try:
            proc.kill()  # SIGKILL fallback
        except Exception:
            pass
