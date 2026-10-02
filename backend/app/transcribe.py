from __future__ import annotations

import json
import logging
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator, Optional

from .models import Segment, Word

log = logging.getLogger(__name__)

@dataclass
class ProbeInfo:
    duration: float
    width: int
    height: int
    is_audio_only: bool = False
    has_audio: bool = True

def probe(video: Path) -> ProbeInfo:
    out = subprocess.run(
        [
            "ffprobe",
            "-v", "error",
            "-show_entries", "stream=codec_type,width,height:format=duration",
            "-of", "json",
            str(video),
        ],
        capture_output=True,
        check=True,
        text=True,
    )
    data = json.loads(out.stdout)
    streams = data.get("streams", [])
    fmt = data.get("format", {})
    duration = float(fmt.get("duration", 0.0))
    vid = next((s for s in streams if s.get("codec_type") == "video"), None)
    aud = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if vid is None:
        if aud is None:
            raise RuntimeError(f"no media streams in {video}")
        return ProbeInfo(duration=duration, width=0, height=0, is_audio_only=True, has_audio=True)
    return ProbeInfo(
        duration=duration,
        width=int(vid.get("width", 0)),
        height=int(vid.get("height", 0)),
        is_audio_only=False,
        has_audio=aud is not None,
    )

import threading as _threading

_whisper_models: dict[str, object] = {}
_align_models: dict[str, tuple[object, dict]] = {}
# Guards model loading. Without it, two concurrent _get_fw_model calls both
# miss the cache, both load the same 3 GB blob from disk, and fight for
# CPU / I/O — observed taking 2× longer on parallel uploads.
_whisper_model_lock = _threading.Lock()
_align_model_lock = _threading.Lock()

_vosk_models: dict[str, object] = {}
_vosk_model_lock = _threading.Lock()

def _device() -> str:
    return os.environ.get("WHISPER_DEVICE", "cpu")

def _compute() -> str:
    return os.environ.get("WHISPER_COMPUTE", "int8")

def _models_dir() -> str:
    return os.environ.get("MODELS_DIR", "/data/models")

def _skip_align() -> bool:
    return os.environ.get("WHISPERX_SKIP_ALIGN", "0") == "1"

def _get_fw_model(name: Optional[str]):
    from faster_whisper import WhisperModel
    import time as _t

    env_name = os.environ.get("WHISPER_MODEL", "large-v3")
    resolved = name or env_name
    if resolved in _whisper_models:
        log.info("whisper.model_cached name=%s", resolved)
        return _whisper_models[resolved]
    with _whisper_model_lock:
        # Double-check: another thread may have finished loading while we
        # were waiting on the lock.
        if resolved in _whisper_models:
            log.info("whisper.model_cached name=%s (after wait)", resolved)
            return _whisper_models[resolved]
        log.info("whisper.model_loading name=%s device=%s compute=%s", resolved, _device(), _compute())
        t0 = _t.perf_counter()
        m = WhisperModel(
            resolved,
            device=_device(),
            compute_type=_compute(),
            download_root=_models_dir(),
        )
        log.info("whisper.model_loaded name=%s elapsed=%.1fs", resolved, _t.perf_counter() - t0)
        _whisper_models[resolved] = m
        return m

def _get_align_model(language: str):
    import whisperx
    import time as _t

    if language in _align_models:
        log.info("align.model_cached lang=%s", language)
        return _align_models[language]
    with _align_model_lock:
        if language in _align_models:
            log.info("align.model_cached lang=%s (after wait)", language)
            return _align_models[language]
        log.info("align.model_loading lang=%s device=%s", language, _device())
        t0 = _t.perf_counter()
        model, meta = whisperx.load_align_model(
            language_code=language,
            device=_device(),
            model_dir=_models_dir(),
        )
        log.info("align.model_loaded lang=%s elapsed=%.1fs", language, _t.perf_counter() - t0)
        _align_models[language] = (model, meta)
    return model, meta

def _get_vosk_model(model_path: str):
    from vosk import Model
    import time as _t

    if model_path in _vosk_models:
        log.info("vosk.model_cached path=%s", model_path)
        return _vosk_models[model_path]
    with _vosk_model_lock:
        if model_path in _vosk_models:
            log.info("vosk.model_cached path=%s (after wait)", model_path)
            return _vosk_models[model_path]
        log.info("vosk.model_loading path=%s", model_path)
        t0 = _t.perf_counter()
        m = Model(model_path)
        log.info("vosk.model_loaded path=%s elapsed=%.1fs", model_path, _t.perf_counter() - t0)
        _vosk_models[model_path] = m
        return m

def _interpolate_word_timings(
    raw_words: list[dict],
    seg_start: float,
    seg_end: float,
) -> list[Word]:
    """Fill in missing start/end via linear interpolation between aligned words.

    whisperX's forced alignment can fail to pin a precise start/end for short
    function words, OOV tokens or noisy spots. The library itself uses
    `interpolate_nans()` for segment ends; we do the same at the word level so
    word/karaoke modes don't drop any words.
    """
    items: list[list] = []
    for w in raw_words:
        txt = str(w.get("word", "")).strip()
        if not txt:
            continue
        s = w.get("start")
        e = w.get("end")
        items.append([
            txt,
            float(s) if s is not None else None,
            float(e) if e is not None else None,
        ])

    n = len(items)
    if n == 0:
        return []

    # If nothing was aligned at all, evenly split the segment.
    if all(it[1] is None for it in items):
        total = max(seg_end - seg_start, 0.01)
        step = total / n
        return [
            Word(start=seg_start + i * step, end=seg_start + (i + 1) * step, text=it[0])
            for i, it in enumerate(items)
        ]

    starts = [it[1] for it in items]
    ends = [it[2] for it in items]

    # Pass 1: fill missing starts via linear interpolation between known anchors.
    i = 0
    while i < n:
        if starts[i] is not None:
            i += 1
            continue
        prev_t = seg_start
        for k in range(i - 1, -1, -1):
            if ends[k] is not None:
                prev_t = ends[k]
                break
            if starts[k] is not None:
                prev_t = starts[k]
                break
        j = i
        while j < n and starts[j] is None:
            j += 1
        next_t = starts[j] if j < n else seg_end
        gap = max(next_t - prev_t, 0.01)
        step = gap / (j - i)
        for k in range(i, j):
            starts[k] = prev_t + (k - i) * step
            if ends[k] is None:
                ends[k] = prev_t + (k - i + 1) * step
        i = j

    # Pass 2: fill missing ends.
    for i in range(n):
        if ends[i] is None:
            ends[i] = starts[i + 1] if i + 1 < n and starts[i + 1] is not None else seg_end

    out: list[Word] = []
    for i, it in enumerate(items):
        s = float(starts[i]) if starts[i] is not None else seg_start
        e = float(ends[i]) if ends[i] is not None else max(s + 0.05, seg_end)
        if e <= s:
            e = s + 0.05
        out.append(Word(start=s, end=e, text=it[0]))
    return out

def _synthesize_words(text: str, start: float, end: float) -> list[Word]:
    toks = text.strip().split()
    if not toks:
        return []
    total = max(end - start, 0.01)
    step = total / len(toks)
    return [
        Word(
            start=start + i * step,
            end=start + (i + 1) * step,
            text=w,
        )
        for i, w in enumerate(toks)
    ]

def _raw_transcribe_stream(
    video: Path,
    language: Optional[str],
    model_name: Optional[str],
) -> Iterator[tuple[dict, object]]:
    """Yield (segment_dict, info) tuples from faster-whisper as they arrive."""
    model = _get_fw_model(model_name)
    lang = None if language in (None, "auto") else language
    segments, info = model.transcribe(
        str(video),
        language=lang,
        beam_size=5,
        # Anti-hallucination / anti-cross-lingual-leak: both taken from the
        # whisperX pipeline's defaults. Without condition_on_previous_text=False
        # a mis-detected first segment locks the model into the wrong language
        # for the whole file and it starts "translating" rather than
        # transcribing. VAD filter gives cleaner segment boundaries and avoids
        # the model inventing speech during silence.
        condition_on_previous_text=False,
        vad_filter=True,
    )
    for seg in segments:
        yield (
            {
                "start": float(seg.start),
                "end": float(seg.end),
                "text": seg.text.strip(),
            },
            info,
        )

ProgressCb = Callable[[str, int], None]
SegmentCb = Callable[[Segment, int, int], None]  # (segment, index, percent)
CancelCheck = Callable[[], bool]

def _align_one(
    raw_seg: dict,
    audio,
    align_model,
    align_meta,
    device: str,
) -> list[Word]:
    """Run wav2vec2 alignment on a single whisper segment. Returns words[]."""
    import whisperx
    try:
        aligned = whisperx.align(
            [raw_seg],
            align_model,
            align_meta,
            audio,
            device=device,
            return_char_alignments=False,
        )
    except Exception as exc:  # pragma: no cover
        log.warning("align.segment_failed t=%.2f-%.2f err=%s", raw_seg["start"], raw_seg["end"], exc)
        return _synthesize_words(raw_seg["text"], raw_seg["start"], raw_seg["end"])

    out_segs = aligned.get("segments", [])
    if not out_segs:
        return _synthesize_words(raw_seg["text"], raw_seg["start"], raw_seg["end"])
    s = out_segs[0]
    seg_start = float(s.get("start", raw_seg["start"]))
    seg_end = float(s.get("end", raw_seg["end"]))
    words = _interpolate_word_timings(s.get("words", []) or [], seg_start, seg_end)
    if not words:
        words = _synthesize_words(raw_seg["text"], seg_start, seg_end)
    return words

def _transcribe_stream_vosk(
    video: Path,
    language: Optional[str],
    on_segment: Optional[SegmentCb],
    on_progress: Optional[ProgressCb],
    cancel_check: Optional[CancelCheck],
) -> tuple[list[Segment], Optional[str]]:
    """Vosk-specific streaming transcription pipeline for Persian."""
    import time as _t
    import subprocess
    from vosk import KaldiRecognizer

    duration = probe(video).duration
    log.info(
        "transcribe_stream_vosk.start duration=%.2fs language_hint=%s",
        duration, language,
    )

    # Get Vosk model path from environment variable
    model_path = os.environ.get("VOSK_FA_MODEL_PATH", "/models/vosk/fa-0.42")
    model = _get_vosk_model(model_path)

    # ffmpeg command to convert to mono 16-bit PCM at 16kHz
    ffmpeg_cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-i", str(video),
        "-f", "s16le",
        "-ac", "1",
        "-ar", "16000",
        "-",
    ]

    # Start ffmpeg process
    ffmpeg_process = subprocess.Popen(
        ffmpeg_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        bufsize=0  # Unbuffered
    )

    # Create Vosk recognizer
    recognizer = KaldiRecognizer(model, 16000)
    recognizer.SetWords(True)

    out: list[Segment] = []
    idx = 0
    t0 = _t.perf_counter()
    words_buffer: list[Word] = []
    segment_start_time: Optional[float] = None
    segment_end_time: Optional[float] = None
    segment_text_parts: list[str] = []

    try:
        while True:
            if cancel_check and cancel_check():
                log.info("transcribe_stream_vosk.cancelled after %d segments", len(out))
                break

            # Read audio data from ffmpeg stdout
            data = ffmpeg_process.stdout.read(4000)  # Read in chunks
            if len(data) == 0:
                break  # End of stream

            if recognizer.AcceptWaveform(data):
                # Get final result
                result_json = recognizer.Result()
                result = json.loads(result_json)
                
                if "result" in result and result["result"]:
                    # Process word-level results
                    for word_info in result["result"]:
                        word = Word(
                            start=float(word_info["start"]),
                            end=float(word_info["end"]),
                            text=word_info["word"]
                        )
                        words_buffer.append(word)
                        
                        # Update segment timing
                        if segment_start_time is None:
                            segment_start_time = word.start
                        segment_end_time = word.end
                        segment_text_parts.append(word.text)
                    
                    # Create segment from buffered words
                    if words_buffer and (segment_end_time is not None) and (segment_start_time is not None):
                        seg = Segment(
                            start=segment_start_time,
                            end=segment_end_time,
                            text=" ".join(segment_text_parts),
                            words=words_buffer.copy(),
                        )
                        out.append(seg)
                        pct = max(0, min(99, int(segment_end_time / duration * 100))) if duration > 0 else 0
                        log.debug("transcribe_stream_vosk.segment idx=%d t=%.2f-%.2f words=%d pct=%d",
                                  idx, seg.start, seg.end, len(seg.words), pct)
                        if on_segment:
                            on_segment(seg, idx, pct)
                        if on_progress:
                            on_progress("transcribe", pct)
                        idx += 1
                        
                        # Reset buffers for next segment
                        words_buffer.clear()
                        segment_start_time = None
                        segment_end_time = None
                        segment_text_parts.clear()
                else:
                    # No words in result, but we might have partial data
                    pass
            else:
                # Get partial result for progress tracking
                partial_json = recognizer.PartialResult()
                partial = json.loads(partial_json)
                # We could use partial for progress if needed, but for now we'll skip

        # Get final remaining results
        final_json = recognizer.FinalResult()
        final_result = json.loads(final_json)
        
        if "result" in final_result and final_result["result"]:
            # Process remaining word-level results
            for word_info in final_result["result"]:
                word = Word(
                    start=float(word_info["start"]),
                    end=float(word_info["end"]),
                    text=word_info["word"]
                )
                words_buffer.append(word)
                
                # Update segment timing
                if segment_start_time is None:
                    segment_start_time = word.start
                segment_end_time = word.end
                segment_text_parts.append(word.text)
            
            # Create final segment from remaining words
            if words_buffer and (segment_end_time is not None) and (segment_start_time is not None):
                seg = Segment(
                    start=segment_start_time,
                    end=segment_end_time,
                    text=" ".join(segment_text_parts),
                    words=words_buffer.copy(),
                )
                out.append(seg)
                pct = max(0, min(99, int(segment_end_time / duration * 100))) if duration > 0 else 0
                log.debug("transcribe_stream_vosk.segment idx=%d t=%.2f-%.2f words=%d pct=%d",
                          idx, seg.start, seg.end, len(seg.words), pct)
                if on_segment:
                    on_segment(seg, idx, pct)
                if on_progress:
                    on_progress("transcribe", pct)
                idx += 1

    finally:
        # Clean up ffmpeg process
        if ffmpeg_process.poll() is None:
            ffmpeg_process.terminate()
            try:
                ffmpeg_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                ffmpeg_process.kill()
                ffmpeg_process.wait()

    if on_progress:
        on_progress("transcribe", 100)
    log.info(
        "transcribe_stream_vosk.done segments=%d lang=fa elapsed=%.1fs",
        len(out), _t.perf_counter() - t0,
    )
    return (out, "fa")

def transcribe_stream(
    video: Path,
    language: Optional[str] = None,
    model_name: Optional[str] = None,
    on_segment: Optional[SegmentCb] = None,
    on_progress: Optional[ProgressCb] = None,
    cancel_check: Optional[CancelCheck] = None,
) -> tuple[list[Segment], Optional[str]]:
    """Streaming pipeline: each whisper segment is per-segment aligned and
    pushed via `on_segment(seg, index, percent)` as soon as its word timings
    are ready. Returns (all_segments, detected_language) when done.

    `cancel_check()` polled between segments; True → stop early.
    """
    # Handle Vosk Persian model
    if model_name == "vosk-fa-0.42":
        return _transcribe_stream_vosk(video, language, on_segment, on_progress, cancel_check)

    import time as _t

    duration = probe(video).duration
    log.info(
        "transcribe_stream.start duration=%.2fs language_hint=%s model=%s",
        duration, language, model_name,
    )

    # Lazy-loaded on first segment; kept across iterations via closure-ish dict
    # (plain vars would reassign but numpy array truthiness confuses naive
    # comparisons, so we use explicit flags).
    audio = None
    align_model = None
    align_meta = None
    align_ready = False
    align_failed = False
    detected_lang: Optional[str] = None
    out: list[Segment] = []
    idx = 0
    t0 = _t.perf_counter()

    want_align = not _skip_align()

    for raw_seg, info in _raw_transcribe_stream(video, language, model_name):
        if cancel_check and cancel_check():
            log.info("transcribe_stream.cancelled after %d segments", len(out))
            return (out, detected_lang)

        # Resolve detected language once (on first segment) so we can load
        # align model lazily.
        if detected_lang is None:
            if language and language != "auto":
                detected_lang = language
            elif info is not None:
                detected_lang = getattr(info, "language", None)
            log.info("transcribe_stream.language detected=%s", detected_lang)

        # Lazy-load audio + align model on first segment.
        if want_align and detected_lang and not align_ready and not align_failed:
            try:
                import whisperx
                audio = whisperx.load_audio(str(video))
                align_model, align_meta = _get_align_model(detected_lang)
                align_ready = True
            except Exception as exc:
                log.warning("align.setup_failed err=%s — falling back to synthesized words", exc)
                align_failed = True

        words: list[Word]
        if align_ready:
            words = _align_one(raw_seg, audio, align_model, align_meta, _device())
        else:
            words = _synthesize_words(raw_seg["text"], raw_seg["start"], raw_seg["end"])

        seg = Segment(
            start=raw_seg["start"],
            end=raw_seg["end"],
            text=raw_seg["text"],
            words=words,
        )
        out.append(seg)
        pct = max(0, min(99, int(raw_seg["end"] / duration * 100))) if duration > 0 else 0
        log.debug("transcribe_stream.segment idx=%d t=%.2f-%.2f words=%d pct=%d",
                  idx, seg.start, seg.end, len(words), pct)
        if on_segment:
            on_segment(seg, idx, pct)
        if on_progress:
            on_progress("transcribe", pct)
        idx += 1

    if on_progress:
        on_progress("transcribe", 100)
    log.info(
        "transcribe_stream.done segments=%d lang=%s elapsed=%.1fs",
        len(out), detected_lang, _t.perf_counter() - t0,
    )
    return (out, detected_lang)

def transcribe(
    video: Path,
    language: Optional[str] = None,
    model_name: Optional[str] = None,
    on_progress: Optional[ProgressCb] = None,
) -> tuple[list[tuple[float, float, str, list[Word]]], Optional[str]]:
    """Transcribe with word-level timings. Returns (segments, detected_language)."""
    import time as _t

    duration = probe(video).duration
    log.info(
        "transcribe.start duration=%.2fs language_hint=%s model_hint=%s",
        duration,
        language,
        model_name,
    )
    raw: list[dict] = []
    info = None
    t_asr = _t.perf_counter()
    for seg, inf in _raw_transcribe_stream(video, language, model_name):
        raw.append(seg)
        info = inf
        log.debug("asr.segment t=%.2f-%.2f text=%r", seg["start"], seg["end"], seg["text"][:80])
        if on_progress and duration > 0:
            pct = max(0, min(99, int(seg["end"] / duration * 100)))
            on_progress("transcribe", pct)
    log.info(
        "asr.done segments=%d elapsed=%.1fs",
        len(raw),
        _t.perf_counter() - t_asr,
    )

    if on_progress:
        on_progress("transcribe", 100)

    detected_lang: Optional[str] = None
    if language and language != "auto":
        detected_lang = language
    elif info is not None:
        detected_lang = getattr(info, "language", None)
    log.info("asr.language detected=%s (user_hint=%s)", detected_lang, language)

    if not raw:
        log.warning("asr.empty no segments produced — returning empty result")
        return ([], detected_lang)

    if _skip_align():
        log.info("align.skipped WHISPERX_SKIP_ALIGN=1 — using synthesized word timings")
        if on_progress:
            on_progress("align", 100)
        return (
            [
                (r["start"], r["end"], r["text"], _synthesize_words(r["text"], r["start"], r["end"]))
                for r in raw
            ],
            detected_lang,
        )
    if not detected_lang:
        log.warning("align.skipped no detected_lang — using synthesized word timings")
        if on_progress:
            on_progress("align", 100)
        return (
            [
                (r["start"], r["end"], r["text"], _synthesize_words(r["text"], r["start"], r["end"]))
                for r in raw
            ],
            detected_lang,
        )

    log.info("align.start lang=%s segments=%d", detected_lang, len(raw))
    if on_progress:
        on_progress("align", 0)
    t_align = _t.perf_counter()

    try:
        import whisperx

        align_model, meta = _get_align_model(detected_lang)
        audio = whisperx.load_audio(str(video))
        aligned = whisperx.align(
            raw,
            align_model,
            meta,
            audio,
            device=_device(),
            return_char_alignments=False,
        )
    except Exception as exc:  # pragma: no cover
        log.warning("align.failed lang=%s err=%s — falling back to synthesized timings", detected_lang, exc)
        if on_progress:
            on_progress("align", 100)
        return (
            [
                (r["start"], r["end"], r["text"], _synthesize_words(r["text"], r["start"], r["end"]))
                for r in raw
            ],
            detected_lang,
        )

    if on_progress:
        on_progress("align", 100)

    out: list[tuple[float, float, str, list[Word]]] = []
    total_words = 0
    skipped_in_align = 0
    for seg in aligned.get("segments", []):
        seg_start = float(seg.get("start", 0.0))
        seg_end = float(seg.get("end", seg_start))
        seg_text = str(seg.get("text", "")).strip()
        raw_words = seg.get("words", []) or []
        skipped_in_align += sum(
            1 for w in raw_words if w.get("start") is None or w.get("end") is None
        )
        words = _interpolate_word_timings(raw_words, seg_start, seg_end)
        if not words:
            words = _synthesize_words(seg_text, seg_start, seg_end)
        total_words += len(words)
        out.append((seg_start, seg_end, seg_text, words))
    if skipped_in_align:
        log.info("align.interpolated %d words had missing timings (filled in)", skipped_in_align)
    log.info(
        "align.done lang=%s segments=%d words=%d elapsed=%.1fs",
        detected_lang,
        len(out),
        total_words,
        _t.perf_counter() - t_align,
    )
    return (out, detected_lang)
