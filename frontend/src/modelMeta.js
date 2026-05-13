// Shared model/provider metadata used by App.jsx and ModelPickerPopover.
// All user-facing strings are Rio-branded — never expose underlying API model
// ids or provider names (Groq / Gemini / OpenAI / Llama / GPT, etc.) in the UI.

export const MODEL_ALIASES = {
  // tier 2 — fast
  'llama-3.3-70b-versatile': 'rio2.1',
  'llama-3.1-8b-instant': 'rio2.2',
  'gemma2-9b-it': 'rio2.3',
  // tier 3 — balanced
  'gemini-2.5-flash': 'rio3.1',
  'gemini-2.5-pro': 'rio3.2',
  'gemini-2.0-flash': 'rio3.3',
  'gemini-1.5-flash': 'rio3.4',
  'gemini-1.5-pro': 'rio3.5',
  // tier 4 — premium
  'openai/gpt-4o': 'rio4.1',
  'openai/gpt-4o-mini': 'rio4.2',
  'meta/Meta-Llama-3.1-70B-Instruct': 'rio4.3',
  'mistral-ai/Mistral-large-2407': 'rio4.4',
};

export function rioAlias(model) {
  if (!model) return '';
  if (MODEL_ALIASES[model]) return MODEL_ALIASES[model];
  const tail = String(model).split('/').pop();
  return MODEL_ALIASES[tail] || 'rio';
}

// Neutral tier labels for provider tabs — no underlying brand names.
export const PROVIDER_SHORT = {
  groq: 'Rio Fast',
  gemini: 'Rio Pro',
  github: 'Rio Premium',
};

// One-line tagline shown under each provider tab. Brand-neutral.
export const PROVIDER_TAGLINE = {
  groq: '⚡ fastest replies',
  gemini: 'best for Hinglish',
  github: 'top quality',
};

// Human-readable description for each model — Rio-branded, no API names.
export const MODEL_DESC = {
  'llama-3.3-70b-versatile': 'best balance · fast',
  'llama-3.1-8b-instant': 'ultra-fast · light tasks',
  'gemma2-9b-it': 'compact · quick replies',
  'gemini-2.5-flash': 'recommended · all-rounder',
  'gemini-2.5-pro': 'best reasoning',
  'gemini-2.0-flash': 'fast · everyday chat',
  'gemini-1.5-flash': 'lightweight · legacy',
  'gemini-1.5-pro': 'deeper context · legacy',
  'openai/gpt-4o': 'top quality · premium',
  'openai/gpt-4o-mini': 'premium · cheaper',
  'meta/Meta-Llama-3.1-70B-Instruct': 'open · large context',
  'mistral-ai/Mistral-large-2407': 'premium · alternative',
};

// Generic description shown when the underlying model is not in MODEL_DESC.
// Never fall back to the raw model id — that would leak the API name.
export const GENERIC_MODEL_DESC = 'Rio AI model';
