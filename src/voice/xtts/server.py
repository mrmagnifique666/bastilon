"""
Voice Cloning Microservice for Kingston / Bastilon OS.

Uses Bark (Suno) via HuggingFace Transformers for voice cloning + TTS.
- French + English + multilingual support
- Voice cloning from ~6 seconds of reference audio
- ~5GB VRAM on RTX 3080
- No C compilation needed (pure Python + PyTorch)

Endpoints:
  POST /tts          — Generate speech from text (using active voice)
  POST /clone         — Clone a voice from an audio file
  GET  /voices        — List available voice profiles
  POST /use           — Set the active voice
  POST /extract-audio — Extract audio from a video file (ffmpeg)
  GET  /health        — Health check
"""

import os
import json
import time
import logging
import subprocess
from pathlib import Path
from typing import Optional

import torch
import torchaudio
import numpy as np
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse
import uvicorn

# ── Paths ──────────────────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
VOICES_DIR = PROJECT_ROOT / "relay" / "voices"
VOICES_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR = PROJECT_ROOT / "relay" / "xtts_output"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ── Logging ────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("xtts")

# ── App ────────────────────────────────────────────────────────────────
app = FastAPI(title="Kingston Voice Server", version="1.0.0")

# Global state
bark_model = None
bark_processor = None
voice_presets: dict = {}  # name → { semantic_prompt, coarse_prompt, fine_prompt }
active_voice: Optional[str] = None
device = "cuda" if torch.cuda.is_available() else "cpu"

SAMPLE_RATE = 24000  # Bark outputs at 24kHz


def get_voice_dir(name: str) -> Path:
    """Get the directory for a voice profile (path-safe)."""
    safe = "".join(c for c in name if c.isalnum() or c in "-_")
    return VOICES_DIR / safe


def list_voice_profiles() -> list[dict]:
    """List all available voice profiles with metadata."""
    voices = []
    if not VOICES_DIR.exists():
        return voices
    for d in sorted(VOICES_DIR.iterdir()):
        if d.is_dir():
            meta_file = d / "meta.json"
            meta = {}
            if meta_file.exists():
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
            audio_files = list(d.glob("*.wav")) + list(d.glob("*.mp3")) + list(d.glob("*.npz"))
            has_preset = (d / "voice_preset.npz").exists()
            voices.append({
                "name": d.name,
                "description": meta.get("description", ""),
                "language": meta.get("language", "fr"),
                "audio_files": len(audio_files),
                "has_preset": has_preset,
                "created": meta.get("created", ""),
            })
    return voices


def find_reference_audio(voice_name: str) -> Optional[Path]:
    """Find the best reference audio file for a voice."""
    voice_dir = get_voice_dir(voice_name)
    if not voice_dir.exists():
        return None
    for ext in ["*.wav", "*.mp3"]:
        files = sorted(voice_dir.glob(ext))
        if files:
            return files[0]
    return None


def load_model():
    """Load Bark model (lazy, on first use)."""
    global bark_model, bark_processor

    if bark_model is not None:
        return bark_model, bark_processor

    log.info(f"Loading Bark model on {device}...")
    start = time.time()

    from transformers import BarkModel, BarkProcessor

    bark_processor = BarkProcessor.from_pretrained(
        "suno/bark",
        torch_dtype=torch.float16 if device == "cuda" else torch.float32,
    )
    bark_model = BarkModel.from_pretrained(
        "suno/bark",
        torch_dtype=torch.float16 if device == "cuda" else torch.float32,
    ).to(device)
    bark_model.eval()

    # Optimize: enable CPU offload for submodels if VRAM is tight
    if device == "cuda":
        bark_model.enable_cpu_offload()

    elapsed = time.time() - start
    vram = torch.cuda.memory_allocated() / 1e9 if device == "cuda" else 0
    log.info(f"Bark loaded in {elapsed:.1f}s on {device} (VRAM: {vram:.1f}GB)")

    return bark_model, bark_processor


def create_voice_preset(audio_path: Path, voice_name: str) -> dict:
    """Create a Bark voice preset from reference audio using EnCodec."""
    log.info(f"Creating voice preset from: {audio_path.name}")

    from encodec import EncodecModel
    from encodec.utils import convert_audio

    # Load EnCodec model
    encodec_model = EncodecModel.encodec_model_24khz()
    encodec_model.set_target_bandwidth(6.0)

    # Load audio
    waveform, sr = torchaudio.load(str(audio_path))

    # Convert to mono + resample to 24kHz
    waveform = convert_audio(waveform, sr, encodec_model.sample_rate, encodec_model.channels)

    # Trim to 10 seconds max
    max_samples = encodec_model.sample_rate * 10
    if waveform.shape[-1] > max_samples:
        waveform = waveform[..., :max_samples]

    # Encode with EnCodec
    with torch.no_grad():
        encoded_frames = encodec_model.encode(waveform.unsqueeze(0))

    # Extract codes for Bark
    codes = encoded_frames[0][0]  # [1, n_codebooks, n_frames]

    # Create Bark-compatible voice preset
    # Bark expects: semantic_prompt, coarse_prompt, fine_prompt
    fine_prompt = codes.squeeze(0).numpy()  # [n_codebooks, n_frames]
    coarse_prompt = fine_prompt[:2, :]  # First 2 codebooks
    # Semantic prompt: use first codebook as approximation
    semantic_prompt = fine_prompt[0, :]

    preset = {
        "semantic_prompt": semantic_prompt,
        "coarse_prompt": coarse_prompt,
        "fine_prompt": fine_prompt,
    }

    # Save preset
    voice_dir = get_voice_dir(voice_name)
    preset_path = voice_dir / "voice_preset.npz"
    np.savez(str(preset_path), **preset)
    log.info(f"Voice preset saved: {preset_path}")

    # Cache
    voice_presets[voice_name] = preset

    return preset


def get_voice_preset(voice_name: str) -> Optional[dict]:
    """Get or load a voice preset."""
    if voice_name in voice_presets:
        return voice_presets[voice_name]

    preset_path = get_voice_dir(voice_name) / "voice_preset.npz"
    if preset_path.exists():
        data = np.load(str(preset_path))
        preset = {
            "semantic_prompt": data["semantic_prompt"],
            "coarse_prompt": data["coarse_prompt"],
            "fine_prompt": data["fine_prompt"],
        }
        voice_presets[voice_name] = preset
        return preset

    # No preset — try to create from reference audio
    ref = find_reference_audio(voice_name)
    if ref:
        try:
            return create_voice_preset(ref, voice_name)
        except Exception as e:
            log.error(f"Failed to create voice preset: {e}")
    return None


# ── Endpoints ──────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model_loaded": bark_model is not None,
        "device": device,
        "active_voice": active_voice,
        "voices": len(list_voice_profiles()),
        "vram_used_gb": round(torch.cuda.memory_allocated() / 1e9, 2) if device == "cuda" else 0,
    }


@app.get("/voices")
async def voices():
    return {"voices": list_voice_profiles(), "active": active_voice}


@app.post("/use")
async def use_voice(voice: str = Form(...)):
    global active_voice
    voice_dir = get_voice_dir(voice)
    if not voice_dir.exists():
        raise HTTPException(404, f"Voice '{voice}' not found")
    active_voice = voice
    log.info(f"Active voice set to: {voice}")
    return {"active": voice}


@app.post("/tts")
async def tts(
    text: str = Form(...),
    voice: Optional[str] = Form(None),
    language: str = Form("fr"),
):
    """Generate speech using Bark with the active (or specified) voice."""
    voice_name = voice or active_voice

    model, processor = load_model()

    log.info(f"Generating TTS: voice={voice_name}, lang={language}, text=\"{text[:60]}...\"")
    start = time.time()

    # Prepare inputs
    tagged_text = text  # Bark presets handle language internally

    # Check if voice_name is a Bark built-in preset (e.g. "v2/fr_speaker_0")
    voice_preset = None
    if voice_name and voice_name.startswith("v2/"):
        # Built-in Bark preset — pass as voice_preset string
        log.info(f"Using Bark built-in preset: {voice_name}")
        inputs = processor(tagged_text, voice_preset=voice_name, return_tensors="pt").to(device)
    else:
        # Custom cloned voice or default
        if voice_name:
            preset_data = get_voice_preset(voice_name)
            if preset_data:
                voice_preset = preset_data
                log.info(f"Using cloned voice: {voice_name}")
            else:
                log.info(f"Voice '{voice_name}' has no preset — using default Bark voice")
        inputs = processor(tagged_text, voice_preset=voice_preset, return_tensors="pt").to(device)

    # Generate
    with torch.no_grad():
        audio_array = model.generate(
            **inputs,
            do_sample=True,
            fine_temperature=0.5,
            coarse_temperature=0.7,
            semantic_temperature=0.7,
        )

    # Convert to numpy
    audio = audio_array.cpu().numpy().squeeze()

    # Save as WAV
    ts = int(time.time() * 1000)
    voice_tag = voice_name or "default"
    out_path = OUTPUT_DIR / f"tts_{voice_tag}_{ts}.wav"

    # Ensure audio is float32 for saving
    if audio.dtype != np.float32:
        audio = audio.astype(np.float32)

    # Normalize
    if np.abs(audio).max() > 0:
        audio = audio / np.abs(audio).max() * 0.95

    audio_tensor = torch.tensor(audio).unsqueeze(0)
    torchaudio.save(str(out_path), audio_tensor, SAMPLE_RATE)

    elapsed = time.time() - start
    log.info(f"TTS done in {elapsed:.1f}s → {out_path.name} ({out_path.stat().st_size / 1024:.0f}KB)")

    return FileResponse(
        str(out_path),
        media_type="audio/wav",
        filename=out_path.name,
        headers={"X-Generation-Time": f"{elapsed:.2f}"},
    )


@app.post("/clone")
async def clone_voice(
    name: str = Form(...),
    description: str = Form(""),
    language: str = Form("fr"),
    audio: UploadFile = File(...),
):
    """Clone a voice from an uploaded audio file (~6-10 seconds of clean speech)."""
    voice_dir = get_voice_dir(name)
    voice_dir.mkdir(parents=True, exist_ok=True)

    # Save the uploaded audio
    ext = Path(audio.filename).suffix or ".wav"
    audio_path = voice_dir / f"reference{ext}"

    content = await audio.read()
    audio_path.write_bytes(content)
    log.info(f"Saved reference audio: {audio_path} ({len(content) / 1024:.0f}KB)")

    # Convert to WAV 24kHz mono (Bark's native rate)
    wav_path = voice_dir / "reference.wav"
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(audio_path), "-ar", "24000", "-ac", "1", str(wav_path)],
            capture_output=True, check=True,
        )
        log.info(f"Converted to WAV 24kHz: {wav_path}")
    except Exception as e:
        log.warning(f"ffmpeg conversion failed: {e}")
        if ext.lower() != ".wav":
            raise HTTPException(500, f"Cannot convert audio: ffmpeg needed. Error: {e}")

    # Create voice preset
    try:
        create_voice_preset(wav_path, name)
    except Exception as e:
        log.error(f"Failed to create voice preset: {e}")
        # Don't fail — voice file is still saved, just no preset

    # Save metadata
    meta = {
        "name": name,
        "description": description,
        "language": language,
        "created": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_file": audio.filename,
        "source_size": len(content),
    }
    (voice_dir / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")

    global active_voice
    active_voice = name
    log.info(f"Voice '{name}' cloned and set as active")

    return {
        "name": name,
        "description": description,
        "language": language,
        "audio_file": "reference.wav",
        "has_preset": (voice_dir / "voice_preset.npz").exists(),
        "active": True,
    }


@app.post("/extract-audio")
async def extract_audio(
    video: UploadFile = File(...),
    voice_name: str = Form(...),
    start_time: str = Form("0"),
    duration: str = Form("30"),
):
    """Extract audio from a video file and create a voice profile."""
    voice_dir = get_voice_dir(voice_name)
    voice_dir.mkdir(parents=True, exist_ok=True)

    # Save uploaded video temporarily
    video_path = OUTPUT_DIR / f"temp_{int(time.time())}_{video.filename}"
    content = await video.read()
    video_path.write_bytes(content)

    # Extract audio with ffmpeg → 24kHz mono WAV
    wav_path = voice_dir / "reference.wav"
    try:
        cmd = [
            "ffmpeg", "-y",
            "-i", str(video_path),
            "-ss", start_time,
            "-t", duration,
            "-ar", "24000", "-ac", "1",
            "-vn",
            str(wav_path),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            raise RuntimeError(result.stderr[:500])
        log.info(f"Extracted audio: {wav_path} ({wav_path.stat().st_size / 1024:.0f}KB)")
    except Exception as e:
        video_path.unlink(missing_ok=True)
        raise HTTPException(500, f"Audio extraction failed: {e}")
    finally:
        video_path.unlink(missing_ok=True)

    # Create voice preset
    try:
        create_voice_preset(wav_path, voice_name)
    except Exception as e:
        log.warning(f"Voice preset creation failed: {e}")

    # Save metadata
    meta = {
        "name": voice_name,
        "description": f"Extracted from {video.filename}",
        "language": "fr",
        "created": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_file": video.filename,
        "extract_start": start_time,
        "extract_duration": duration,
    }
    (voice_dir / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")

    global active_voice
    active_voice = voice_name

    return {
        "name": voice_name,
        "audio_file": "reference.wav",
        "size_kb": round(wav_path.stat().st_size / 1024),
        "has_preset": (voice_dir / "voice_preset.npz").exists(),
        "active": True,
    }


# ── Main ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    port = int(os.environ.get("XTTS_PORT", "3300"))
    log.info(f"Starting Kingston Voice Server on port {port}...")
    log.info(f"Device: {device} | CUDA: {torch.cuda.is_available()}")
    if device == "cuda":
        log.info(f"GPU: {torch.cuda.get_device_name(0)}")
        log.info(f"VRAM: {torch.cuda.get_device_properties(0).total_memory / 1e9:.1f}GB")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
