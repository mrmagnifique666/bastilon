"""
Faster-Whisper STT Microservice for Kingston / Bastilon OS.

Local speech-to-text using faster-whisper (CTranslate2) with:
- Bilingual FR/EN recognition
- RPG vocabulary prompts (Shadowrun, D&D)
- WebSocket streaming for real-time PTT
- HTTP one-shot for file transcription
- CUDA float16 on RTX 3080 (~3GB VRAM)

Endpoints:
  GET  /health         — Server status + model info
  POST /transcribe     — One-shot transcription (PCM/WAV body)
  WS   /ws/transcribe  — Streaming: auth JSON → PCM chunks → transcripts
"""

import os
import json
import time
import logging
import asyncio
import struct
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Response
from fastapi.responses import JSONResponse
import uvicorn

# ─── Configuration ────────────────────────────────────────────────────────────
PORT = int(os.environ.get("WHISPER_PORT", "3301"))
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "large-v3")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "float16")
DEVICE = os.environ.get("WHISPER_DEVICE", "cuda")
MODEL_CACHE = os.environ.get("WHISPER_MODEL_CACHE", "D:/whisper-models")
LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "fr")
RPG_MODE = os.environ.get("WHISPER_RPG_MODE", "shadowrun")
AUTH_TOKEN = os.environ.get("DASHBOARD_TOKEN", "")
SAMPLE_RATE = 16000  # Expected PCM sample rate

# Streaming config
ACCUMULATE_SECONDS = 2.0  # Transcribe accumulated audio every N seconds
MIN_AUDIO_SECONDS = 0.3   # Minimum audio length to bother transcribing

logging.basicConfig(level=logging.INFO, format="[whisper] %(message)s")
logger = logging.getLogger("whisper")

# ─── RPG Prompts ──────────────────────────────────────────────────────────────
PROMPTS_FILE = Path(__file__).parent / "rpg_prompts.json"

def load_rpg_prompt(mode: str) -> str:
    """Load RPG vocabulary prompt for initial_prompt."""
    if not PROMPTS_FILE.exists():
        return ""
    try:
        with open(PROMPTS_FILE, "r", encoding="utf-8") as f:
            prompts = json.load(f)
        # Combine requested mode + bilingual base
        parts = []
        if mode in prompts:
            parts.append(prompts[mode])
        if "bilingual" in prompts and mode != "bilingual":
            parts.append(prompts["bilingual"])
        return " ".join(parts)
    except Exception as e:
        logger.warning(f"Failed to load RPG prompts: {e}")
        return ""

# ─── Model Management ─────────────────────────────────────────────────────────
model = None
model_load_time: Optional[float] = None

def get_model():
    """Lazy-load faster-whisper model."""
    global model, model_load_time
    if model is not None:
        return model

    from faster_whisper import WhisperModel

    logger.info(f"Loading {MODEL_SIZE} ({COMPUTE_TYPE}) on {DEVICE}...")
    logger.info(f"Model cache: {MODEL_CACHE}")
    start = time.time()

    os.makedirs(MODEL_CACHE, exist_ok=True)
    model = WhisperModel(
        MODEL_SIZE,
        device=DEVICE,
        compute_type=COMPUTE_TYPE,
        download_root=MODEL_CACHE,
    )

    model_load_time = time.time() - start
    logger.info(f"Model loaded in {model_load_time:.1f}s")
    return model

def _run_transcribe(audio_input, language: str, initial_prompt: str) -> dict:
    """
    Core transcription. audio_input can be:
    - np.ndarray (float32 mono 16kHz) — from WebSocket PCM streaming
    - io.BytesIO — from HTTP endpoint (any format: WAV/MP3/etc, any sample rate)
    faster-whisper handles BytesIO via av/ffmpeg (auto resample + mono conversion).
    """
    m = get_model()

    kwargs = {
        "language": language if language != "auto" else None,
        "beam_size": 5,
        "vad_filter": True,
        "vad_parameters": {"min_silence_duration_ms": 500},
    }
    if initial_prompt:
        kwargs["initial_prompt"] = initial_prompt

    segments_gen, info = m.transcribe(audio_input, **kwargs)
    segments = list(segments_gen)

    text = " ".join(s.text.strip() for s in segments if s.text.strip())
    return {
        "text": text,
        "segments": [
            {
                "start": s.start,
                "end": s.end,
                "text": s.text.strip(),
                "avg_logprob": s.avg_logprob,
            }
            for s in segments
        ],
        "language": info.language if info else language,
        "language_probability": info.language_probability if info else 0,
    }

def transcribe_file(audio_bytes: bytes, language: str = LANGUAGE, initial_prompt: str = "") -> dict:
    """Transcribe any audio file (WAV/MP3/etc) — faster-whisper decodes via av/ffmpeg."""
    import io
    return _run_transcribe(io.BytesIO(audio_bytes), language, initial_prompt)

def transcribe_pcm(pcm_bytes: bytes, language: str = LANGUAGE, initial_prompt: str = "") -> dict:
    """Transcribe raw 16-bit PCM mono 16kHz from WebSocket streaming."""
    audio = pcm16_to_float32(pcm_bytes)
    if len(audio) < int(SAMPLE_RATE * MIN_AUDIO_SECONDS):
        return {"text": "", "segments": [], "language": language}
    return _run_transcribe(audio, language, initial_prompt)

def pcm16_to_float32(pcm_bytes: bytes) -> np.ndarray:
    """Convert 16-bit signed PCM bytes to float32 numpy array."""
    samples = np.frombuffer(pcm_bytes, dtype=np.int16)
    return samples.astype(np.float32) / 32768.0

# ─── FastAPI App ──────────────────────────────────────────────────────────────
app = FastAPI(title="Kingston Whisper STT", version="1.0.0")

@app.get("/health")
async def health():
    """Health check + model status."""
    try:
        import torch
        vram_used = torch.cuda.memory_allocated() / 1e9 if torch.cuda.is_available() else 0
        vram_total = torch.cuda.get_device_properties(0).total_mem / 1e9 if torch.cuda.is_available() else 0
    except Exception:
        vram_used = 0
        vram_total = 0

    return {
        "ok": True,
        "model": MODEL_SIZE,
        "compute_type": COMPUTE_TYPE,
        "device": DEVICE,
        "model_loaded": model is not None,
        "model_load_time": model_load_time,
        "language": LANGUAGE,
        "rpg_mode": RPG_MODE,
        "vram_used_gb": round(vram_used, 2),
        "vram_total_gb": round(vram_total, 2),
        "sample_rate": SAMPLE_RATE,
    }

@app.post("/transcribe")
async def transcribe_endpoint(request: Request):
    """One-shot transcription from PCM or WAV body."""
    body = await request.body()
    if not body:
        return JSONResponse({"error": "Empty body"}, status_code=400)

    content_type = request.headers.get("content-type", "")
    language = request.headers.get("x-language", LANGUAGE)
    rpg_mode = request.headers.get("x-rpg-mode", RPG_MODE)

    prompt = load_rpg_prompt(rpg_mode)

    start = time.time()
    # Use transcribe_file for any format (WAV/MP3/etc, any sample rate/channels)
    # faster-whisper decodes via av/ffmpeg internally
    result = transcribe_file(body, language=language, initial_prompt=prompt)
    result["duration_ms"] = round((time.time() - start) * 1000)

    return result

@app.websocket("/ws/transcribe")
async def ws_transcribe(ws: WebSocket):
    """
    Streaming STT via WebSocket.

    Protocol:
    1. Client sends JSON: {"type":"auth","token":"...","sampleRate":16000,"language":"fr","rpgMode":"shadowrun"}
    2. Server replies JSON: {"type":"authenticated"} then {"type":"ready"}
    3. Client sends binary PCM chunks (16-bit signed, mono)
    4. Server sends JSON: {"type":"transcript","text":"...","is_final":false,"speech_final":false}
    5. Client sends JSON: {"type":"finalize"} to get final transcript
    6. Server replies with is_final=true transcript
    """
    await ws.accept()

    authenticated = False
    language = LANGUAGE
    rpg_prompt = ""
    sample_rate = SAMPLE_RATE
    audio_buffer = bytearray()
    last_transcribe_time = time.time()

    try:
        # ── Auth phase ────────────────────────────────────────────────
        try:
            raw = await asyncio.wait_for(ws.receive_text(), timeout=5.0)
            msg = json.loads(raw)
        except (asyncio.TimeoutError, json.JSONDecodeError):
            await ws.send_json({"type": "error", "message": "Auth timeout or invalid JSON"})
            await ws.close()
            return

        if msg.get("type") != "auth":
            await ws.send_json({"type": "error", "message": "First message must be auth"})
            await ws.close()
            return

        if AUTH_TOKEN and msg.get("token") != AUTH_TOKEN:
            await ws.send_json({"type": "error", "message": "Invalid token"})
            await ws.close()
            return

        authenticated = True
        language = msg.get("language", LANGUAGE)
        sample_rate = msg.get("sampleRate", SAMPLE_RATE)
        rpg_mode = msg.get("rpgMode", RPG_MODE)
        rpg_prompt = load_rpg_prompt(rpg_mode)

        await ws.send_json({"type": "authenticated"})

        # Pre-load model in background
        get_model()
        await ws.send_json({"type": "ready"})
        logger.info(f"WS client connected (lang={language}, rpg={rpg_mode})")

        # ── Streaming phase ───────────────────────────────────────────
        while True:
            message = await ws.receive()

            if message["type"] == "websocket.disconnect":
                break

            # Binary = PCM audio chunk
            if "bytes" in message and message["bytes"]:
                audio_buffer.extend(message["bytes"])

                # Check if enough audio accumulated for interim transcription
                elapsed = time.time() - last_transcribe_time
                buffer_seconds = len(audio_buffer) / (sample_rate * 2)  # 2 bytes per sample

                if elapsed >= ACCUMULATE_SECONDS and buffer_seconds >= MIN_AUDIO_SECONDS:
                    result = transcribe_pcm(bytes(audio_buffer), language=language, initial_prompt=rpg_prompt)
                    if result["text"]:
                        await ws.send_json({
                            "type": "transcript",
                            "text": result["text"],
                            "is_final": False,
                            "speech_final": False,
                        })
                    last_transcribe_time = time.time()

            # Text = JSON control messages
            elif "text" in message and message["text"]:
                try:
                    ctrl = json.loads(message["text"])
                except json.JSONDecodeError:
                    continue

                if ctrl.get("type") == "finalize":
                    # Final transcription of all accumulated audio
                    if len(audio_buffer) > 0:
                        result = transcribe_pcm(bytes(audio_buffer), language=language, initial_prompt=rpg_prompt)
                        await ws.send_json({
                            "type": "transcript",
                            "text": result["text"],
                            "is_final": True,
                            "speech_final": True,
                        })
                    else:
                        await ws.send_json({
                            "type": "transcript",
                            "text": "",
                            "is_final": True,
                            "speech_final": True,
                        })
                    # Send utterance_end to match Deepgram protocol
                    await ws.send_json({"type": "utterance_end"})
                    audio_buffer.clear()
                    last_transcribe_time = time.time()

                elif ctrl.get("type") == "reset":
                    audio_buffer.clear()
                    last_transcribe_time = time.time()

    except WebSocketDisconnect:
        logger.info("WS client disconnected")
    except Exception as e:
        logger.error(f"WS error: {e}")
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        logger.info("WS session ended")

# ─── Main ─────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    logger.info(f"Starting Whisper STT on port {PORT}")
    logger.info(f"Model: {MODEL_SIZE} | Compute: {COMPUTE_TYPE} | Device: {DEVICE}")
    logger.info(f"Language: {LANGUAGE} | RPG mode: {RPG_MODE}")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
