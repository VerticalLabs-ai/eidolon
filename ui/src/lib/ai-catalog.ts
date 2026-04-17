export const PROVIDER_OPTIONS: { value: string; label: string }[] = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "google", label: "Google" },
  { value: "local", label: "Local (Ollama)" },
];

export const SECRET_PROVIDER_OPTIONS = [...PROVIDER_OPTIONS];

export const PROVIDER_ICONS: Record<string, string> = {
  anthropic: "A",
  openai: "O",
  google: "G",
  local: "L",
  ollama: "L",
};

const LOCAL_MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: "gemma4", label: "Gemma 4" },
  { value: "gemma4:27b", label: "Gemma 4 27B" },
  { value: "gemma4:12b", label: "Gemma 4 12B" },
  { value: "gemma4:4b", label: "Gemma 4 4B" },
  { value: "llama3.2", label: "Llama 3.2" },
  { value: "deepseek-r1", label: "DeepSeek R1" },
  { value: "qwen3", label: "Qwen 3" },
  { value: "mistral", label: "Mistral (local)" },
  { value: "phi4", label: "Phi 4" },
];

export const MODELS_BY_PROVIDER: Record<string, { value: string; label: string }[]> = {
  anthropic: [
    { value: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { value: "claude-opus-4-7-1m", label: "Claude Opus 4.7 (1M context)" },
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  openai: [
    { value: "gpt-5.4", label: "GPT-5.4" },
    { value: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
    { value: "gpt-5.4-nano", label: "GPT-5.4 Nano" },
    { value: "o3", label: "o3" },
    { value: "o4-mini", label: "o4-mini" },
  ],
  google: [
    { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
    { value: "gemini-3-flash-preview", label: "Gemini 3.0 Flash" },
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  ],
  local: LOCAL_MODEL_OPTIONS,
  ollama: LOCAL_MODEL_OPTIONS,
};

export function normalizeProvider(provider?: string | null): string {
  if (!provider) {
    return "anthropic";
  }

  if (provider === "ollama") {
    return "local";
  }

  return provider in MODELS_BY_PROVIDER ? provider : "anthropic";
}

export function getModelOptions(provider?: string | null) {
  return MODELS_BY_PROVIDER[normalizeProvider(provider)] ?? [];
}
