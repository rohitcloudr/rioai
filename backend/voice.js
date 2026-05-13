import OpenAI from 'openai';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const OPENAI_VOICES = new Set(['nova', 'shimmer', 'alloy', 'onyx', 'echo', 'fable']);
const MAX_INPUT_CHARS = 4000;

// Edge TTS — free, no key, Microsoft Neural voices
const EDGE_VOICES = {
  'en-IN': { female: 'en-IN-NeerjaNeural', male: 'en-IN-PrabhatNeural' },
  'hi-IN': { female: 'hi-IN-SwaraNeural', male: 'hi-IN-MadhurNeural' },
  'en-US': { female: 'en-US-JennyNeural', male: 'en-US-GuyNeural' },
};

// Google Cloud TTS — paid (free tier with billing enabled)
const GOOGLE_VOICES = {
  'en-IN': { female: 'en-IN-Wavenet-A', male: 'en-IN-Wavenet-B' },
  'hi-IN': { female: 'hi-IN-Wavenet-A', male: 'hi-IN-Wavenet-B' },
  'en-US': { female: 'en-US-Neural2-F', male: 'en-US-Neural2-D' },
};

function isPlaceholder(key) {
  return !key || key.includes('paste') || key.includes('YOUR-');
}

function clampText(text) {
  const t = (text ?? '').trim();
  if (!t) {
    const err = new Error('text is required');
    err.status = 400;
    throw err;
  }
  return t.length > MAX_INPUT_CHARS ? t.slice(0, MAX_INPUT_CHARS) : t;
}

function pickGender(voicePref) {
  return voicePref === 'male' ? 'male' : 'female';
}

async function edgeSynthesize(text, voicePref, lang) {
  const langCode = lang || 'en-IN';
  const family = EDGE_VOICES[langCode] || EDGE_VOICES['en-IN'];
  const voiceName = family[pickGender(voicePref)];

  const tts = new MsEdgeTTS();
  await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(text);

  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      try {
        tts.close();
      } catch {}
      val instanceof Error ? reject(val) : resolve(val);
    };
    audioStream.on('data', (c) => chunks.push(c));
    audioStream.on('close', () => finish(Buffer.concat(chunks)));
    audioStream.on('end', () => finish(Buffer.concat(chunks)));
    audioStream.on('error', (e) => {
      const err = new Error(`Edge TTS error: ${e?.message ?? e}`);
      err.status = 500;
      finish(err);
    });
    setTimeout(() => {
      const err = new Error('Edge TTS timeout');
      err.status = 504;
      finish(err);
    }, 20000);
  });
}

async function googleSynthesize(text, voicePref, lang) {
  const apiKey = process.env.GOOGLE_TTS_API_KEY;
  if (isPlaceholder(apiKey)) return null;

  const langCode = lang || 'en-IN';
  const family = GOOGLE_VOICES[langCode] || GOOGLE_VOICES['en-IN'];
  const voiceName = family[pickGender(voicePref)];

  const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(apiKey)}`;
  const body = {
    input: { text },
    voice: { languageCode: langCode, name: voiceName },
    audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0, pitch: 0.0 },
  };

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = `Google TTS error ${r.status}`;
    try {
      const j = await r.json();
      msg = j?.error?.message || msg;
    } catch {}
    const err = new Error(msg);
    err.status = r.status === 429 ? 429 : r.status >= 400 && r.status < 500 ? 400 : 500;
    err.provider = 'google';
    throw err;
  }
  const data = await r.json();
  if (!data?.audioContent) {
    const err = new Error('Google TTS returned no audio');
    err.status = 500;
    throw err;
  }
  return Buffer.from(data.audioContent, 'base64');
}

async function openaiSynthesize(text, voicePref) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (isPlaceholder(apiKey)) return null;

  const voice = OPENAI_VOICES.has(voicePref)
    ? voicePref
    : voicePref === 'male'
      ? 'onyx'
      : 'nova';

  const client = new OpenAI({ apiKey });
  const response = await client.audio.speech.create({
    model: 'tts-1',
    voice,
    input: text,
    response_format: 'mp3',
  });
  return response.body;
}

export async function synthesizeSpeech(text, voicePref, lang) {
  const safeText = clampText(text);
  const provider = (process.env.TTS_PROVIDER || 'edge').toLowerCase();

  // Explicit override via TTS_PROVIDER env var
  if (provider === 'google' && !isPlaceholder(process.env.GOOGLE_TTS_API_KEY)) {
    return await googleSynthesize(safeText, voicePref, lang);
  }
  if (provider === 'openai' && !isPlaceholder(process.env.OPENAI_API_KEY)) {
    return await openaiSynthesize(safeText, voicePref);
  }

  // Default: Edge (free, no key). Falls back to Google → OpenAI on failure.
  try {
    return await edgeSynthesize(safeText, voicePref, lang);
  } catch (edgeErr) {
    if (!isPlaceholder(process.env.GOOGLE_TTS_API_KEY)) {
      try {
        return await googleSynthesize(safeText, voicePref, lang);
      } catch {}
    }
    if (!isPlaceholder(process.env.OPENAI_API_KEY)) {
      try {
        return await openaiSynthesize(safeText, voicePref);
      } catch {}
    }
    throw edgeErr;
  }
}
