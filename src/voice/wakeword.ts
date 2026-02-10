/**
 * Wake Word Listener — "Computer" activates Kingston via local microphone.
 *
 * Uses Picovoice Porcupine for wake word detection (offline, ~0% CPU).
 * Uses PvRecorder for cross-platform microphone access.
 *
 * Flow:
 *   1. Continuously listen for wake word ("Computer" by default)
 *   2. On detection → play notification sound + desktop notification
 *   3. Record audio for up to 10 seconds (or until 2s silence)
 *   4. Send to Deepgram STT → Kingston orchestrator → ElevenLabs TTS
 *   5. Play response through speakers
 *
 * Config:
 *   PICOVOICE_ACCESS_KEY — required (free at picovoice.ai)
 *   WAKEWORD_KEYWORD — "computer" | "jarvis" | "terminator" (default: "computer")
 *   WAKEWORD_DEVICE_INDEX — microphone index (default: 0)
 *   WAKEWORD_SENSITIVITY — 0.0-1.0, higher = more sensitive (default: 0.5)
 */
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { handleMessage } from "../orchestrator/router.js";
import { logError } from "../storage/store.js";

// State
let listening = false;
let porcupineInstance: any = null;
let recorderInstance: any = null;
let listenInterval: ReturnType<typeof setInterval> | null = null;
let isProcessingCommand = false;

// Config helpers
function getAccessKey(): string {
  return process.env["PICOVOICE_ACCESS_KEY"] || "";
}

function getKeyword(): string {
  return (process.env["WAKEWORD_KEYWORD"] || "computer").toUpperCase();
}

function getDeviceIndex(): number {
  return Number(process.env["WAKEWORD_DEVICE_INDEX"] || "0");
}

function getSensitivity(): number {
  return Number(process.env["WAKEWORD_SENSITIVITY"] || "0.5");
}

/**
 * Start listening for wake word.
 * Returns true if started successfully, false otherwise.
 */
export async function startWakeWord(): Promise<boolean> {
  if (listening) {
    log.warn("[wakeword] Already listening");
    return true;
  }

  const accessKey = getAccessKey();
  if (!accessKey) {
    log.warn("[wakeword] PICOVOICE_ACCESS_KEY not set — wake word disabled. Get a free key at https://picovoice.ai");
    return false;
  }

  try {
    const { Porcupine, BuiltinKeyword } = await import("@picovoice/porcupine-node");
    const { PvRecorder } = await import("@picovoice/pvrecorder-node");

    const keyword = getKeyword();
    const builtinKeyword = (BuiltinKeyword as any)[keyword];
    if (!builtinKeyword && builtinKeyword !== 0) {
      log.error(`[wakeword] Invalid keyword "${keyword}". Available: ${Object.keys(BuiltinKeyword).join(", ")}`);
      return false;
    }

    const sensitivity = getSensitivity();
    log.info(`[wakeword] Initializing Porcupine — keyword: "${keyword}", sensitivity: ${sensitivity}`);

    porcupineInstance = new Porcupine(accessKey, [builtinKeyword], [sensitivity]);

    const frameLength = porcupineInstance.frameLength;
    const sampleRate = porcupineInstance.sampleRate;
    const deviceIndex = getDeviceIndex();

    log.info(`[wakeword] Frame: ${frameLength} samples, rate: ${sampleRate}Hz, device: ${deviceIndex}`);

    recorderInstance = new PvRecorder(frameLength, deviceIndex);
    recorderInstance.start();

    listening = true;
    log.info(`[wakeword] 🎙️ Listening for "${keyword}" on microphone ${deviceIndex}...`);

    // Notify Nicolas
    try {
      const { exec } = await import("node:child_process");
      exec(`powershell -Command "New-BurntToastNotification -Text 'Kingston Wake Word', 'Listening for \\"${keyword}\\"... Say it to talk to Kingston!'" 2>NUL`, () => {});
    } catch { /* notification is optional */ }

    // Main listen loop — Porcupine processes frame by frame
    listenInterval = setInterval(async () => {
      if (!listening || !recorderInstance || !porcupineInstance || isProcessingCommand) return;

      try {
        const frame = recorderInstance.read();
        const keywordIndex = porcupineInstance.process(frame);

        if (keywordIndex >= 0) {
          log.info(`[wakeword] 🔔 Wake word detected! Keyword: "${keyword}"`);
          await onWakeWordDetected(frame, recorderInstance, porcupineInstance);
        }
      } catch (err) {
        // Don't spam logs for read errors during shutdown
        if (listening) {
          log.debug(`[wakeword] Frame error: ${err}`);
        }
      }
    }, Math.floor((frameLength / sampleRate) * 1000)); // process at frame rate

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[wakeword] Failed to start: ${msg}`);
    logError(err instanceof Error ? err : msg, "wakeword:start");
    cleanup();
    return false;
  }
}

/**
 * Called when wake word is detected — record command, process, respond.
 */
async function onWakeWordDetected(
  _lastFrame: Int16Array,
  recorder: any,
  _porcupine: any,
): Promise<void> {
  if (isProcessingCommand) return;
  isProcessingCommand = true;

  try {
    // Desktop notification
    try {
      const { exec } = await import("node:child_process");
      exec(`powershell -Command "New-BurntToastNotification -Text 'Kingston', 'Je t\\'ecoute...'" 2>NUL`, () => {});
    } catch { /* optional */ }

    // Record audio for up to 8 seconds after wake word
    // Collect PCM frames → convert to WAV → send to Deepgram
    const sampleRate = 16000;
    const maxFrames = Math.ceil((8 * sampleRate) / recorder.frameLength); // ~8 seconds
    const silenceThreshold = 500; // RMS below this = silence
    const silenceFramesRequired = Math.ceil((2 * sampleRate) / recorder.frameLength); // 2s silence = stop

    const allFrames: Int16Array[] = [];
    let silenceCount = 0;

    log.info("[wakeword] 🎤 Recording command...");

    for (let i = 0; i < maxFrames; i++) {
      const frame = recorder.read();
      allFrames.push(new Int16Array(frame));

      // Check RMS energy for silence detection
      let rms = 0;
      for (let j = 0; j < frame.length; j++) {
        rms += frame[j] * frame[j];
      }
      rms = Math.sqrt(rms / frame.length);

      if (rms < silenceThreshold) {
        silenceCount++;
        if (silenceCount >= silenceFramesRequired && allFrames.length > silenceFramesRequired) {
          log.debug(`[wakeword] Silence detected after ${allFrames.length} frames — stopping recording`);
          break;
        }
      } else {
        silenceCount = 0;
      }
    }

    // Combine all frames into a single buffer
    const totalSamples = allFrames.reduce((acc, f) => acc + f.length, 0);
    const pcmBuffer = new Int16Array(totalSamples);
    let offset = 0;
    for (const frame of allFrames) {
      pcmBuffer.set(frame, offset);
      offset += frame.length;
    }

    const durationSecs = (totalSamples / sampleRate).toFixed(1);
    log.info(`[wakeword] Recorded ${durationSecs}s of audio (${totalSamples} samples)`);

    if (totalSamples < sampleRate * 0.5) {
      log.info("[wakeword] Recording too short — ignoring");
      return;
    }

    // Convert PCM to WAV buffer
    const wavBuffer = pcmToWav(pcmBuffer, sampleRate);

    // Send to Deepgram for transcription
    const transcript = await transcribeWithDeepgram(wavBuffer);

    if (!transcript || transcript.trim().length === 0) {
      log.info("[wakeword] No speech detected — ignoring");
      try {
        const { exec } = await import("node:child_process");
        exec(`powershell -Command "New-BurntToastNotification -Text 'Kingston', 'Je n\\'ai rien entendu.'" 2>NUL`, () => {});
      } catch { /* optional */ }
      return;
    }

    log.info(`[wakeword] 📝 Transcript: "${transcript}"`);

    // Process through Kingston
    const chatId = config.voiceChatId || 0;
    const userId = config.voiceUserId || 8189338836;
    const response = await handleMessage(chatId, `[Wake Word] ${transcript}`, userId);

    log.info(`[wakeword] 🤖 Response: "${response.slice(0, 100)}..."`);

    // Notify via desktop
    const shortResponse = response.slice(0, 200).replace(/'/g, "\\'").replace(/"/g, '\\"');
    try {
      const { exec } = await import("node:child_process");
      exec(`powershell -Command "New-BurntToastNotification -Text 'Kingston', '${shortResponse}'" 2>NUL`, () => {});
    } catch { /* optional */ }

    // TTS response via speakers (if ElevenLabs configured)
    if (config.elevenlabsApiKey) {
      try {
        const { textToSpeechMp3 } = await import("./elevenlabs.js");
        const mp3Buffer = await textToSpeechMp3(response.slice(0, 500));
        if (mp3Buffer && mp3Buffer.length > 0) {
          // Write to temp file and play
          const fs = await import("node:fs");
          const path = await import("node:path");
          const tmpFile = path.join(process.env["TEMP"] || "/tmp", "kingston-response.mp3");
          fs.writeFileSync(tmpFile, mp3Buffer);
          const { exec } = await import("node:child_process");
          exec(`powershell -Command "(New-Object Media.SoundPlayer '${tmpFile}').PlaySync()"`, () => {});
          log.info("[wakeword] 🔊 Playing TTS response");
        }
      } catch (err) {
        log.debug(`[wakeword] TTS playback failed: ${err}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[wakeword] Command processing error: ${msg}`);
    logError(err instanceof Error ? err : msg, "wakeword:process");
  } finally {
    isProcessingCommand = false;
  }
}

/** Convert PCM Int16 samples to WAV buffer */
function pcmToWav(samples: Int16Array, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * (bitsPerSample / 8);
  const headerSize = 44;

  const buffer = Buffer.alloc(headerSize + dataSize);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  // fmt subchunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // subchunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data subchunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  // PCM data
  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i], headerSize + i * 2);
  }

  return buffer;
}

/** Send WAV buffer to Deepgram REST API for transcription */
async function transcribeWithDeepgram(wavBuffer: Buffer): Promise<string> {
  const apiKey = config.deepgramApiKey;
  if (!apiKey) {
    log.warn("[wakeword] DEEPGRAM_API_KEY not set — cannot transcribe");
    return "";
  }

  try {
    const response = await fetch("https://api.deepgram.com/v1/listen?model=nova-2&language=fr&smart_format=true", {
      method: "POST",
      headers: {
        "Authorization": `Token ${apiKey}`,
        "Content-Type": "audio/wav",
      },
      body: wavBuffer,
    });

    if (!response.ok) {
      log.error(`[wakeword] Deepgram API error: ${response.status} ${response.statusText}`);
      return "";
    }

    const data = await response.json() as any;
    const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    return transcript;
  } catch (err) {
    log.error(`[wakeword] Deepgram transcription error: ${err}`);
    return "";
  }
}

/** Stop listening */
export function stopWakeWord(): void {
  listening = false;
  cleanup();
  log.info("[wakeword] 🔇 Stopped listening");
}

/** Get current status */
export function getWakeWordStatus(): { listening: boolean; keyword: string; processing: boolean } {
  return {
    listening,
    keyword: getKeyword(),
    processing: isProcessingCommand,
  };
}

function cleanup(): void {
  if (listenInterval) {
    clearInterval(listenInterval);
    listenInterval = null;
  }
  if (recorderInstance) {
    try { recorderInstance.stop(); } catch { /* already stopped */ }
    try { recorderInstance.release(); } catch { /* already released */ }
    recorderInstance = null;
  }
  if (porcupineInstance) {
    try { porcupineInstance.release(); } catch { /* already released */ }
    porcupineInstance = null;
  }
  listening = false;
}
