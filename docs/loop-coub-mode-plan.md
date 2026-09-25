# Loop / Coub Mode — Implementation Plan

Документ самодостаточен. Чужой LLM/инженер должен суметь по нему сделать фичу, не задавая вопросов автору.

---

## 0. Что это за фича (одним абзацем)

В редакторе появляется тумблер **Loop**. Когда он включён и пользователь подгрузил **extra audio**, выбранный ползунками кусок видео `[in_sec..out_sec]` автоматически зацикливается на всю длину extra audio — и в превью, и в экспорте. Сабы могут генерироваться отдельно из extra audio (по кнопке) и в редакторе сабов появляется переключатель «активной дорожки сабов»: source / extra. Аудио-микс остаётся ручным — source mute и громкости юзер крутит ползунками сам. На вход также принимается `.gif` как обычный видео-файл.

Аналог: Coub. Кусок видео крутится по кругу под музыку/озвучку, сверху сабы.

---

## 1. Что было обсуждено и согласовано (контекст для пустого чата)

Это решения юзера. Не отступать от них.

1. **Loop = только пометка**. Тумблер «Loop» помечает выбранный trim-кусок как зацикливаемый. Никакой автомагии: source-аудио НЕ мьютится автоматически, сабы НЕ перегенериваются автоматически.
2. **Аудио-микс — только руками**. Юзер крутит `sourceVolume` и `extraVolume` слайдерами. Если он хочет тишины от source — ставит slider в 0. Никаких автоматических действий.
3. **Сабы из extra — по кнопке**. Не автомат. Кнопка «Сгенерировать сабы из этой дорожки» появляется в UI рядом с extra audio. По нажатию запускается обычный whisper-pipeline на extra audio, появляется второй набор сегментов.
4. **Активная дорожка сабов** — переключатель в редакторе сабов (вкладки «Source / Extra»). Переключает ТОЛЬКО сабы. Аудио независимо.
5. **Длительность экспорта при loop=ON**:
   - есть extra audio → длина = `extra_audio_duration`, видео-кусок зацикливается ffmpeg'ом;
   - нет extra audio → loop ничего не делает (пометка остаётся, но нечем мерить длину).
6. **Источник сабов для редактирования и экспорта** — тот, что выбран в редакторе сабов. Если активны сабы из source — они привязаны к таймлайну source и при loop=ON повторяются в каждой итерации петли (перерасчёт времён по модулю длины петли). Юзер сам несёт ответственность за выбор: если он выбрал source-сабы под extra audio, это его выбор.
7. **GIF на входе** — принимаем `.gif` как обычный видео-файл в существующем `/api/transcribe`. Никакой особой ветки. Whisper пропускает (нет аудио-дорожки), фронт получает video_id и duration.
8. **Превью**: master-clock = extra audio (если есть и loop=ON), иначе = source video. Видео-элемент управляется JS — при достижении `out_sec` делается seek в `in_sec`, и так пока extra audio не закончится.

---

## 2. Что пощупать в проекте ПЕРЕД написанием кода

Открой и пробеги глазами эти файлы — ниже все ключевые точки расширения.

### Backend (FastAPI + ffmpeg + faster-whisper)

| Файл | Что там лежит |
|------|---------------|
| [backend/app/main.py](../backend/app/main.py) | Все API-эндпоинты, оркестрация транскриба, экспорт |
| [backend/app/models.py](../backend/app/models.py) | Pydantic-модели: `Trim`, `AudioMix`, `ExportRequest`, `Segment`, и т.д. |
| [backend/app/transcribe.py](../backend/app/transcribe.py) | `probe()`, `transcribe_stream()`, faster-whisper wrapper |
| [backend/app/renderer.py](../backend/app/renderer.py) | Полный рендер с Chromium-оверлеем, ffmpeg pipe, amix |
| [backend/app/simple_export.py](../backend/app/simple_export.py) | Fast-paths: stream_copy и filter_only (без Chromium) |
| [backend/app/silence.py](../backend/app/silence.py) | `cuts_from_words()`, `retime_segments()` — уже умеет ретаймить сегменты |
| [backend/app/burn.py](../backend/app/burn.py) | Сжигание ASS через libass (legacy путь) |
| [backend/app/overlay_timing.py](../backend/app/overlay_timing.py) | Расчёт точек смены оверлея |

**Ключевые номера строк (на момент написания плана; перепроверить):**
- `models.py` — `Trim`, `AudioMix`, `ExportRequest` (~L80-200), `Segment` (~L40-70).
- `main.py:617` — `POST /api/transcribe` — обычная загрузка видео + whisper.
- `main.py:1227` — `POST /api/extra-audio` — загрузка доп. аудио.
- `main.py:1341` — `api_export` — главный экспортный эндпоинт. **Здесь** считается `new_duration` и выбирается ветка рендера (stream_copy / filter_only / full).
- `main.py:1389` — расчёт длительности после trim/silence.
- `main.py:1407-1411` — резолв `extra_audio_path`.
- `main.py:1452-1516` — диспетчер веток рендера.
- `main.py:1537-1548` — пост-конвертация в GIF на выходе (если `format=gif`).
- `renderer.py:198, 282` — `amix=inputs=2:duration=first:normalize=0`.
- `simple_export.py:69, 106, 88` — фильтры trim/scale/overlay.

### Frontend (React 18 + Zustand + Vite)

| Файл | Что там лежит |
|------|---------------|
| [frontend/src/store.ts](../frontend/src/store.ts) | Zustand store с persist, версия v7. **Бампим до v8** + миграция |
| [frontend/src/audioMix.ts](../frontend/src/audioMix.ts) | WebAudio граф, синхронизация video↔extra |
| [frontend/src/api.ts](../frontend/src/api.ts) | Клиент API |
| [frontend/src/components/Timeline.tsx](../frontend/src/components/Timeline.tsx) | TrimBar, SourceTrack, ExtraTrack |
| [frontend/src/components/VideoPreview.tsx](../frontend/src/components/VideoPreview.tsx) | `<video>` элемент, currentTime master |
| [frontend/src/components/SubtitleOverlay.tsx](../frontend/src/components/SubtitleOverlay.tsx) | Рендер активных сабов |
| [frontend/src/components/SegmentList.tsx](../frontend/src/components/SegmentList.tsx) | Редактор сабов (списком) |
| [frontend/src/components/PreviewToolbar.tsx](../frontend/src/components/PreviewToolbar.tsx) | Play/pause, scrubber |
| [frontend/src/components/Uploader.tsx](../frontend/src/components/Uploader.tsx) | Загрузка видео |

**Ключевые точки:**
- `store.ts` — `TrimRange`, `AudioConfig`, версия persist (поднять с 7 до 8, написать миграцию).
- `audioMix.ts:140` — `syncExtraToVideo()` — здесь сейчас extra тянется за видео. **В loop-режиме инверсия**: видео тянется за extra.
- `Timeline.tsx:41-50` — TrimBar с двумя ползунками. Рядом ставим Loop-тумблер.
- `Timeline.tsx:235-320` — ExtraTrack. Рядом ставим кнопку «Сгенерировать сабы из extra».
- `SegmentList.tsx` — наверху ставим переключатель «Source / Extra».

### Тесты

| Файл | Что там |
|------|---------|
| [backend/tests/](../backend/tests) | pytest: `test_main.py`, `test_export_dispatch.py`, `test_trim_and_audio.py`, `test_transcribe.py`, `test_gif_export.py`, и т.д. |
| [frontend/e2e/](../frontend/e2e) | Playwright: `01-upload.spec.ts` … `13-loop-mode.spec.ts` |
| [frontend/e2e/_helpers.ts](../frontend/e2e/_helpers.ts) | `uploadEnglish`, `SAMPLE_5S`, `SAMPLE_LONG` |
| [frontend/e2e/11-trim-and-audio.spec.ts](../frontend/e2e/11-trim-and-audio.spec.ts) | Шаблон для нашего нового теста |
| [frontend/playwright.config.ts](../frontend/playwright.config.ts) | base URL `http://localhost:8000` |

---

## 3. Что нужно сделать (high-level)

### 3.1. Модель данных

Бэк (`models.py`):
```python
class Trim(BaseModel):
    in_sec: float = 0.0
    out_sec: float = 0.0
    loop: bool = False                      # NEW

class AudioMix(BaseModel):
    source_volume: float = 1.0
    extra_audio_id: str | None = None
    extra_volume: float = 1.0
    # (без изменений — mics остаются ручными)

class SubtitleTrack(str, Enum):             # NEW
    source = "source"
    extra = "extra"

class ExportRequest(BaseModel):
    # ...
    subtitle_track: SubtitleTrack = SubtitleTrack.source   # NEW
    # `segments` — это сегменты ТОЙ дорожки, что выбрана как активная;
    # фронт сам решает что отправить (segments_source vs segments_extra).
```

Фронт (`store.ts`, версия v8):
```ts
type TrimRange = {
  in_sec: number;
  out_sec: number;
  loop: boolean;                            // NEW (default false)
}

type AudioConfig = {
  sourceVolume: number;
  extraAudioId: string | null;
  extraAudioName: string | null;
  extraAudioDuration: number;               // уже есть
  extraVolume: number;
}

// Сегменты для двух дорожек хранятся параллельно:
type State = {
  segments: Segment[];                      // legacy alias = segmentsBySource
  segmentsSource: Segment[];                // NEW (был просто `segments`)
  segmentsExtra: Segment[];                 // NEW
  subtitleTrack: "source" | "extra";        // NEW (default "source")
  // ...
}
```

Миграция v7→v8: `segments → segmentsSource`, `segmentsExtra = []`, `trimRange.loop = false`, `subtitleTrack = "source"`.

### 3.2. Backend: транскриб extra audio

Новый эндпоинт:
```
POST /api/transcribe-extra
  multipart: extra_audio_id, language, model_size
  → TranscribeResponse { segments, language, duration, ... }
```

Реюзает `transcribe_stream()` из [backend/app/transcribe.py](../backend/app/transcribe.py). По сути — клон `_run_transcribe_stream`, только источник: файл из `_find_extra_audio(extra_id)` вместо `UPLOADS_DIR / video_id`. Стримит прогресс через тот же WebSocket-канал (`ws.push(jid, ...)`).

Хранение: сегменты сохраняются в meta.json проекта в новое поле `extra_segments` (рядом с существующими `segments`). При повторной загрузке проекта подтягиваются оба набора.

### 3.3. Backend: loop в экспорте

В `api_export` (main.py:1341):

1. Разрезолвить `extra_audio_path` (как уже делается).
2. Если `req.trim.loop and extra_audio_path is not None`:
   - `loop_clip_duration = trim_out - trim_in` (длина куска видео)
   - `extra_dur = ffprobe(extra_audio_path)`
   - `final_duration = extra_dur`
   - **Новая ветка рендера** (см. ниже)
   Иначе — текущая логика без изменений.

3. ffmpeg-команда для loop+extra (в [renderer.py](../backend/app/renderer.py) и [simple_export.py](../backend/app/simple_export.py)):
   ```
   ffmpeg -y \
     -ss {trim_in} -t {loop_clip_duration} -i {video} \
     -i {extra_audio} \
     -filter_complex "
       [0:v]loop=loop=-1:size=1:start=0,trim=duration={extra_dur},setpts=N/FRAME_RATE/TB[v];
       [0:a]aloop=loop=-1:size={size_samples},atrim=duration={extra_dur},asetpts=N/SR/TB[a0];
       [a0]volume={source_volume}[a0v];
       [1:a]volume={extra_volume}[a1v];
       [a0v][a1v]amix=inputs=2:duration=first:normalize=0[a]
     " \
     -map "[v]" -map "[a]" -shortest output.mp4
   ```
   Альтернатива через `-stream_loop`:
   ```
   ffmpeg -stream_loop -1 -ss {trim_in} -t {extra_dur} -i {video} \
          -i {extra_audio} ...
   ```
   Для `-stream_loop` нужен seekable input — ок для локальных файлов. Решение: **пробуем `-stream_loop` первым** (проще), фолбэк на `loop` filter если ffmpeg/codec капризничает на конкретных контейнерах.

4. Сегменты сабов (из активной дорожки):
   - если `subtitle_track == "extra"` — `segments` приходят с фронта уже с таймингами по extra-аудио и НЕ ретаймятся.
   - если `subtitle_track == "source"` и loop=ON — сегменты «размножаются» на каждую итерацию петли:
     ```python
     def expand_loop_segments(segments, loop_clip_dur, total_dur):
         out = []
         offset = 0.0
         while offset < total_dur:
             for s in segments:
                 ns = max(0, s.start - trim_in) + offset
                 ne = max(0, s.end - trim_in) + offset
                 if ns >= total_dur: break
                 out.append({**s, "start": ns, "end": min(ne, total_dur)})
             offset += loop_clip_dur
         return out
     ```
   Эта функция — новый чистый утилитарный модуль `backend/app/loop_segments.py` (легко юнит-тестить).

5. Диспатч-логика (main.py:1452-1516): добавить ветку
   ```python
   if loop_active:
       return _render_loop(...)
   elif ...
   ```
   `_render_loop` живёт в [renderer.py](../backend/app/renderer.py) рядом с обычным рендером.

### 3.4. Backend: GIF на входе

В `/api/transcribe` (main.py:617):
- Whitelist расширений: добавить `.gif` (если ещё нет).
- `probe()` ([backend/app/transcribe.py](../backend/app/transcribe.py)) уже умеет ffprobe — для GIF без аудио вернёт `has_audio=False, duration=N`. Этого достаточно.
- Если `has_audio=False` → пропустить whisper, вернуть пустой `segments=[]`. Это уже работает (см. флаг `isAudioOnly`/no-audio path).
- Для гарантированной плавности при превью можно при загрузке конвертировать GIF → MP4 (h264) **только если duration > 1s**. Опционально, для v1 — пропустить, GIF ходят в `<video>` напрямую.

### 3.5. Frontend: store

`store.ts` v8:
- В `migrate(state, version)` ветка `if (version < 8)`:
  ```ts
  return {
    ...state,
    trimRange: { ...state.trimRange, loop: false },
    segmentsSource: state.segments ?? [],
    segmentsExtra: [],
    subtitleTrack: "source",
  };
  ```
- Геттер активных сегментов: `getActiveSegments(s) = s.subtitleTrack === "extra" ? s.segmentsExtra : s.segmentsSource`.
- Сеттеры: `setLoop(b)`, `setSubtitleTrack(t)`, `setExtraSegments(seg)`, `setSourceSegments(seg)`.
- **Computed длина превью**:
  ```ts
  const projectDuration = (s: State) => {
    const trimDur = (s.trimRange.out_sec || s.duration) - s.trimRange.in_sec;
    if (s.trimRange.loop && s.audio.extraAudioDuration > 0) {
      return s.audio.extraAudioDuration;
    }
    return trimDur;
  };
  ```

### 3.6. Frontend: UI

**Timeline.tsx:**
- Loop-тумблер рядом с TrimBar. testid: `loop-toggle`.
- На ExtraTrack — кнопка «Generate subs from this track». testid: `extra-transcribe-button`. Виден только когда `extraAudioId != null`.
- Индикатор прогресса транскриба extra (тот же WS-канал, новый phase: `transcribe_extra_done`).

**SegmentList.tsx:**
- Сверху таб-переключатель Source / Extra. testid: `subtitle-track-source` / `subtitle-track-extra`.
- Таб Extra disabled, если `segmentsExtra.length === 0`.

**VideoPreview.tsx + audioMix.ts:**
- Новый режим `loopMode`. Активен когда `trimRange.loop && extraAudioId`.
- Когда `loopMode=true`:
  - master-clock = `extraEl.currentTime`
  - в каждом `requestAnimationFrame`:
    ```ts
    const m = extraEl.currentTime;
    const phase = (m % loopClipDur);
    const target = trimRange.in_sec + phase;
    if (Math.abs(videoEl.currentTime - target) > 0.05) {
      videoEl.currentTime = target;
    }
    ```
  - play/pause: `togglePlay()` дёргает оба элемента, но «master» — extra.
  - seek от пользователя по таймлайну (0..extraDur) → выставляем оба: `extraEl.currentTime = t`, видео — по формуле выше.
- Когда `loopMode=false`: текущая логика без изменений.

**Сабы** ([SubtitleOverlay.tsx](../frontend/src/components/SubtitleOverlay.tsx)):
- Берут активные сегменты (`getActiveSegments`).
- Берут master-clock от того же источника, что превью использует (см. выше).
- Никакой ретайм на фронте: для preview source-сегментов в loop-режиме либо рисуем «как есть» (повторятся естественно, т.к. видео крутится и `videoEl.currentTime` идёт в первой итерации цикла), либо считаем `phase` и матчим к сегменту по `phase`. **Решение:** в loop-режиме сабы матчатся по `phase` (видеошной координате) — иначе source-сабы покажутся только в первой итерации. Это та же логика, что и `expand_loop_segments` на бэке, только без материализации списка.

### 3.7. Frontend: API клиент (`api.ts`)

```ts
export async function transcribeExtra(
  extra_audio_id: string,
  opts: { language: string; model_size?: string }
): Promise<TranscribeResponse> { ... }
```

Запрос на `/api/transcribe-extra`, прогресс — тот же WS-канал.

В `ExportRequest` сериализуем:
```ts
{
  trim: { in_sec, out_sec, loop },
  audio: { ... },
  subtitle_track: "source" | "extra",
  segments: getActiveSegments(state),    // ← решает фронт
  // ...
}
```

---

## 4. Список новых testid'ов (для Playwright)

| testid | Где | Что делает |
|--------|-----|-----------|
| `loop-toggle` | Timeline | Тумблер Loop |
| `extra-transcribe-button` | Timeline / ExtraTrack | Кнопка «Сгенерировать сабы из extra» |
| `subtitle-track-source` | SegmentList header | Таб «Source» |
| `subtitle-track-extra` | SegmentList header | Таб «Extra» |
| `project-duration` | где-то на превью | Текстовое поле с итоговой длиной (для assertions) |

---

## 5. Тестирование

Цель: ничего из этого не выкатывается без зелёных тестов на трёх уровнях.

### 5.1. Backend pytest

Запуск: `cd backend && pytest -x`.

**Новый файл `backend/tests/test_loop_segments.py`:**
- `expand_loop_segments` на пустом списке → `[]`.
- 1 сегмент `[0..2]`, loop_clip=5, total=12 → 3 копии: `[0..2], [5..7], [10..12]`.
- Сегмент пересекает конец петли → обрезается. `seg=[3..6]`, loop_clip=5, total=10 → `[3..5]` (обрезан по концу петли) либо целиком, в зависимости от выбранной семантики (закрепить в тесте).
- Сегмент с `start < trim_in` → отрицательное смещение, проверить корректную обработку.

**Новый файл `backend/tests/test_loop_export.py`:**
- Замокать ffmpeg через `subprocess.run` patch и проверить что в args присутствуют `-stream_loop` либо `loop=loop=-1:` фильтр и `-t {extra_dur}`.
- Реальный мини-рендер: 2-секундный видео-фикстура + 8-секундный mp3 → ffprobe выдаёт длительность ≈ 8 сек.
- Проверить `subtitle_track="extra"` ветку: ASS-файл строится из `segments` без ретайма.
- Проверить `subtitle_track="source" + loop=true`: ASS содержит N копий каждого сегмента (N = ceil(total/loop_clip)).

**Дополнить `backend/tests/test_transcribe.py`:**
- Тест `/api/transcribe-extra`: загружаем мокнутую extra audio (через существующий `/api/extra-audio`), потом вызываем новый эндпоинт, ожидаем `segments` непустыми (с замоканным faster-whisper).

**Дополнить `backend/tests/test_export_dispatch.py`:**
- При `trim.loop=true && extra_audio_id` диспатч уходит в `_render_loop`, не в `stream_copy`/`filter_only`.
- При `trim.loop=true && extra_audio_id is None` — ветка та же, что без loop (loop игнорируется).

**Дополнить `backend/tests/test_gif_export.py`:**
- `/api/transcribe` принимает `.gif` файл, возвращает `has_audio=false`, `segments=[]`, `duration > 0`.

### 5.2. Frontend Playwright

Запуск: `cd frontend && npm run test:e2e`. Сервер: `docker-compose up` или локальный uvicorn на `localhost:8000`. Фикстуры: `frontend/e2e/fixtures/sample_5s.mp4`, `sample_long.mp4`. Шаблон: [11-trim-and-audio.spec.ts](../frontend/e2e/11-trim-and-audio.spec.ts).

**Новый файл `frontend/e2e/13-loop-mode.spec.ts`:**

```ts
test.describe.configure({ mode: "serial" });

test("loop migrate v7→v8", async ({ page }) => {
  // Засеять v7-state в localStorage, перезагрузить, проверить что
  // trimRange.loop === false и появились segmentsSource/segmentsExtra.
});

test("loop=ON without extra audio: project duration unchanged", async ({ page }) => {
  // upload sample_5s, включить loop-toggle, без extra audio.
  // Проверить: project-duration ≈ 5s (как был).
});

test("loop=ON + extra audio (10s tone): preview master clock = extra audio", async ({ page }) => {
  // upload 5s sample, set trim [0..3], add 10s tone, toggle loop.
  // Play 4 секунды — extraEl.currentTime должно быть ~4, videoEl.currentTime
  // должен быть в диапазоне [0..3] (внутри петли). После 6 секунд проигрывания
  // extraEl.currentTime ≈ 6, videoEl.currentTime ≈ (6 % 3) = 0.
  // Использовать window.__cutstorm_mix как в `extra audio plays through WebAudio mix`.
});

test("loop export: 3s video + 9s audio → output ≈ 9s", async ({ page }) => {
  // upload 5s, trim [0..3], extra=9s tone, loop ON, export.
  // ffprobe → duration ∈ [8.5..9.5].
});

test("transcribe-extra: button generates segmentsExtra and enables Extra tab", async ({ page }) => {
  // upload, add extra audio (короткий TTS-сэмпл), нажать `extra-transcribe-button`.
  // Дождаться `transcribe_extra_done` через WS.
  // Проверить: `subtitle-track-extra` уже не disabled.
  // Кликнуть в `subtitle-track-extra` — список SegmentList сменился.
});

test("subtitle source switch: only subs change, not audio", async ({ page }) => {
  // upload (с источным аудио, есть source-сабы), добавить extra, сгенерить
  // extra-сабы, переключить в `subtitle-track-extra`.
  // Проверить: SubtitleOverlay показывает текст из segmentsExtra. Аудио-микс
  // не изменился (sourceVolume и extraVolume остались как были).
});

test("loop=ON + subtitle_track=source: source subs повторяются с петлёй", async ({ page }) => {
  // upload видео с одним источным сегментом в [0..1.5], trim [0..3], loop ON,
  // extra=9s. Превью на t=0.5 → виден саб. Превью на t=3.5 (= phase 0.5
  // во второй итерации) → саб ВИДЕН снова.
});

test("loop=ON + subtitle_track=extra → exported MP4 has subs aligned to extra", async ({ page }) => {
  // upload, trim, extra audio, transcribe-extra, switch to extra, export.
  // ffprobe -show_streams: длина ≈ длина extra. Открыть burned ASS / прогнать
  // OCR на 1-м кадре после первого сегмента extra → текст совпадает.
  // (OCR опционально; минимум — длительность + статус 200).
});

test("GIF input: upload .gif → preview работает, no audio path", async ({ page }) => {
  // Создать /tmp/test.gif (через ffmpeg lavfi), загрузить через file-input.
  // Проверить: timeline появился, isAudioOnly=false, duration > 0,
  // segments=[] (нет аудио-дорожки → whisper пропущен), preview-video виден.
});
```

### 5.3. Ручная проверка (smoke)

Перед маркировкой «готово»:

1. `docker-compose up`, открыть `http://localhost:8000`.
2. Загрузить 30-секундное видео с озвучкой → дождаться сабов.
3. Поставить trim `[5..10]`. Включить loop-toggle.
4. Добавить extra audio (подкаст, 60 сек).
5. Превью: scrubber становится 60 сек, видео крутится петлёй, source-сабы повторяются на каждой итерации, extra audio играет линейно.
6. Нажать `extra-transcribe-button`. Дождаться. Переключиться в `Extra` в редакторе сабов. Превью теперь показывает сабы из extra audio.
7. Поставить sourceVolume в 0 ползунком. Звук теперь только из extra.
8. Export. Скачанный MP4 длится ≈ 60 сек, видео крутится петлёй, сабы из extra ложатся правильно.
9. Загрузить `.gif` (10-секундный, без звука). Превью работает. Включить loop, добавить extra audio. Export → длина = длина extra, картинка крутится.

---

## 6. Acceptance criteria (что значит «готово»)

- [ ] Все существующие pytest и Playwright-тесты зелёные (никаких регрессий в trim/extra audio/export-веток).
- [ ] Новый файл тестов `test_loop_segments.py` зелёный.
- [ ] Новый файл тестов `test_loop_export.py` зелёный.
- [ ] Новый файл `13-loop-mode.spec.ts` зелёный целиком.
- [ ] Ручной smoke по разделу 5.3 пройден от и до на чистом state (`localStorage.clear()`).
- [ ] При loop=ON без extra — экспорт идентичен экспорту без loop (флаг просто не действует).
- [ ] Миграция v7→v8 не ломает существующие сохранённые проекты в localStorage.
- [ ] GIF на входе принимается обоими ветками (с loop и без).
- [ ] Source-волуме и Extra-волуме никем не трогаются автоматически — только пользователем.

---

## 7. Out of scope (явно НЕ делаем в этой задаче)

- Авто-mute source при включении loop. Никогда. Юзер сам.
- Авто-генерация сабов из extra при загрузке. Никогда. Только по кнопке.
- Поддержка `.gif` на ВЫХОДЕ для loop-режима — оставить как есть (формат gif на выходе уже работает через постпроцесс из MP4, см. `main.py:1537-1548`; loop-mp4 → gif будет работать автоматически).
- Multi-track extra audio (более одной доп. дорожки). Только одна.
- Crossfade в петле, ease-in/out, motion-blur. Hard cut.
- Несколько loop-сегментов в одном видео. Один trim — одна петля.

---

## 8. Порядок реализации (предлагаемый)

1. `models.py` — добавить поля. **Прогнать pytest** — увидеть что ничего не сломалось.
2. `loop_segments.py` + `test_loop_segments.py`. Зелёные.
3. Renderer-ветка `_render_loop` + `test_loop_export.py` (моки на ffmpeg сначала, потом реальный мини-рендер). Зелёные.
4. Эндпоинт `/api/transcribe-extra` + дополнить `test_transcribe.py`. Зелёные.
5. Бэк целиком: `pytest -x`. Зелёный.
6. `store.ts` v7→v8 миграция. Smoke-тест в браузере: загрузить старый state, проверить что не падает.
7. UI: Loop-toggle, кнопка `extra-transcribe-button`, переключатель `subtitle-track-*`.
8. `audioMix.ts` loop-режим (master = extra).
9. `SubtitleOverlay.tsx` — phase-матчинг для loop+source.
10. `13-loop-mode.spec.ts` — добавлять тесты по одному, каждый проходит локально.
11. Ручной smoke-проход по 5.3.
12. Финал: полный pytest + полный playwright + smoke.

---

## 9. Риски и заметки на потом

- **`-stream_loop` vs `loop` filter**: `-stream_loop` проще, но требует seekable input и не дружит с некоторыми контейнерами. Сначала `-stream_loop`, при ошибке логировать и фолбэчить на filter. Покрыть оба пути в тесте.
- **GIF без duration в metadata**: ffprobe может вернуть `N/A` для duration старых GIF. Если так — посчитать через `nb_frames / r_frame_rate`. Уже есть в `transcribe.probe()` — проверить.
- **WebAudio context не запускается без user gesture**: уже решено в текущем коде (`resumeAudioContext` в click-handler), не сломать при правках audioMix.
- **persist миграция**: пользователь мог сидеть на v6, не на v7. Цепочка миграций должна работать v6→v7→v8. Прогнать существующие миграции в pytest-фикстуре localStorage (см. `11-trim-and-audio.spec.ts` начало — там есть пример).
- **WS-канал для transcribe-extra**: использовать тот же job_id-канал, новый phase-string `transcribe_extra_progress` / `transcribe_extra_done`. Фронт слушает оба.

---

## 10. Глоссарий (на случай разночтения)

- **trim** — диапазон `[in_sec..out_sec]`, выбранный ползунками. Кусок видео, который пойдёт в экспорт.
- **loop_clip_duration** = `out_sec - in_sec`. Длина одной итерации петли.
- **extra audio** — доп. аудио-файл, загруженный пользователем. Хранится в `uploads/extra_*.mp3` (или другое расширение). Резолвится через `_find_extra_audio()`.
- **master clock** — источник «текущего времени» для превью. Без loop = `videoEl.currentTime`. С loop+extra = `extraEl.currentTime`.
- **active subtitle track** — `state.subtitleTrack`, либо `"source"`, либо `"extra"`. Определяет какие сегменты видны в редакторе и пойдут в экспорт.
- **phase** — `master_clock % loop_clip_duration`. Координата внутри одной итерации петли. Видео seek-ается в `trim_in + phase`.
