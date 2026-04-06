import { useState, useEffect, useMemo } from "react";
import { Modal } from "@/components/ui/Modal";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { useCreateAgent, useAgents } from "@/lib/hooks";
import { clsx } from "clsx";

interface CreateAgentModalProps {
  open: boolean;
  onClose: () => void;
  companyId: string;
}

const roleOptions = [
  { value: "engineering", label: "Engineering" },
  { value: "marketing", label: "Marketing" },
  { value: "sales", label: "Sales" },
  { value: "operations", label: "Operations" },
  { value: "design", label: "Design" },
  { value: "research", label: "Research" },
  { value: "finance", label: "Finance" },
];

const providerOptions = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "google", label: "Google" },
  { value: "mistral", label: "Mistral" },
  { value: "ollama", label: "Ollama" },
  { value: "custom", label: "Custom" },
];

const MODELS_BY_PROVIDER: Record<string, { value: string; label: string }[]> = {
  anthropic: [
    { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
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
  mistral: [
    { value: "mistral-large-latest", label: "Mistral Large" },
    { value: "mistral-medium-latest", label: "Mistral Medium" },
    { value: "mistral-small-latest", label: "Mistral Small" },
  ],
  ollama: [
    { value: "gemma4", label: "Gemma 4" },
    { value: "gemma4:26b", label: "Gemma 4 26B" },
    { value: "llama3.2", label: "Llama 3.2" },
    { value: "deepseek-r1", label: "DeepSeek R1" },
    { value: "qwen3", label: "Qwen 3" },
    { value: "mistral", label: "Mistral (local)" },
    { value: "phi4", label: "Phi 4" },
  ],
  custom: [{ value: "custom", label: "Custom Model" }],
};

const ROLE_DEFAULTS: Record<
  string,
  {
    temperature: number;
    maxTokens: number;
    systemPrompt: string;
    suggestedTitle: string;
  }
> = {
  engineering: {
    temperature: 0.3,
    maxTokens: 8192,
    systemPrompt:
      "You are a senior software engineer. Write clean, well-tested code. Follow established patterns and conventions. Break down complex tasks into smaller units.",
    suggestedTitle: "Senior Software Engineer",
  },
  marketing: {
    temperature: 0.8,
    maxTokens: 4096,
    systemPrompt:
      "You are a creative marketing strategist. Create compelling content, analyze metrics, and develop data-driven campaign strategies.",
    suggestedTitle: "Marketing Strategist",
  },
  sales: {
    temperature: 0.7,
    maxTokens: 4096,
    systemPrompt:
      "You are a skilled sales representative. Qualify leads, manage the pipeline, and create compelling proposals. Focus on understanding customer needs.",
    suggestedTitle: "Sales Representative",
  },
  operations: {
    temperature: 0.4,
    maxTokens: 4096,
    systemPrompt:
      "You are an operations manager. Optimize workflows, manage resources, monitor system health, and coordinate cross-team initiatives.",
    suggestedTitle: "Operations Manager",
  },
  design: {
    temperature: 0.7,
    maxTokens: 4096,
    systemPrompt:
      "You are a product designer. Create user interfaces, conduct design research, build design systems, and prototype solutions. Prioritize accessibility.",
    suggestedTitle: "Product Designer",
  },
  research: {
    temperature: 0.5,
    maxTokens: 8192,
    systemPrompt:
      "You are a research analyst. Conduct thorough market and competitive research, analyze data, identify trends, and provide actionable recommendations.",
    suggestedTitle: "Research Analyst",
  },
  finance: {
    temperature: 0.2,
    maxTokens: 4096,
    systemPrompt:
      "You are a finance analyst. Track budgets, create forecasts, analyze cost-benefit, and generate financial reports with precision.",
    suggestedTitle: "Finance Analyst",
  },
};

const PROVIDER_ICONS: Record<string, string> = {
  anthropic: "A",
  openai: "O",
  google: "G",
  mistral: "M",
  custom: "C",
};

export function CreateAgentModal({
  open,
  onClose,
  companyId,
}: CreateAgentModalProps) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("engineering");
  const [title, setTitle] = useState("");
  const [provider, setProvider] = useState("anthropic");
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [budgetDollars, setBudgetDollars] = useState("100");
  const [capabilities, setCapabilities] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [temperature, setTemperature] = useState("0.3");
  const [maxTokens, setMaxTokens] = useState("8192");
  const [reportsTo, setReportsTo] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const { data: agents } = useAgents(companyId);
  const mutation = useCreateAgent(companyId);

  const modelOptions = MODELS_BY_PROVIDER[provider] ?? [];

  // When role changes, apply defaults
  useEffect(() => {
    const defaults = ROLE_DEFAULTS[role];
    if (defaults) {
      setTemperature(String(defaults.temperature));
      setMaxTokens(String(defaults.maxTokens));
      if (!systemPrompt) {
        setSystemPrompt(defaults.systemPrompt);
      }
      if (!title) {
        setTitle(defaults.suggestedTitle);
      }
    }
  }, [role]);

  // When provider changes, reset model to first option
  useEffect(() => {
    const opts = MODELS_BY_PROVIDER[provider];
    if (opts && opts.length > 0 && !opts.find((m) => m.value === model)) {
      setModel(opts[0].value);
    }
  }, [provider]);

  const agentOptions = useMemo(
    () =>
      (agents ?? []).map((a) => ({
        value: a.id,
        label: `${a.name} (${a.role})`,
      })),
    [agents],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate(
      {
        name,
        role,
        title,
        provider,
        model,
        reportsTo: reportsTo || undefined,
        systemPrompt: systemPrompt || undefined,
        budgetMonthlyCents: Math.round(
          parseFloat(budgetDollars || "0") * 100,
        ),
        capabilities: capabilities
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      },
      {
        onSuccess: () => {
          onClose();
          resetForm();
        },
      },
    );
  };

  const resetForm = () => {
    setName("");
    setRole("engineering");
    setTitle("");
    setProvider("anthropic");
    setModel("claude-sonnet-4-6");
    setBudgetDollars("100");
    setCapabilities("");
    setSystemPrompt("");
    setTemperature("0.3");
    setMaxTokens("8192");
    setReportsTo("");
    setShowAdvanced(false);
  };

  return (
    <Modal open={open} onClose={onClose} title="Hire New Agent">
      <form
        onSubmit={handleSubmit}
        className="space-y-4 max-h-[65vh] overflow-y-auto pr-1"
      >
        <Input
          label="Agent Name"
          placeholder="e.g., Alex the Engineer"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Input
          label="Title"
          placeholder="e.g., Senior Software Engineer"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
        <Select
          label="Role"
          options={roleOptions}
          value={role}
          onChange={(e) => {
            setRole(e.target.value);
            const defaults = ROLE_DEFAULTS[e.target.value];
            if (defaults) {
              setTitle(defaults.suggestedTitle);
              setSystemPrompt(defaults.systemPrompt);
            }
          }}
        />

        {/* Provider selection with icons */}
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-text-secondary">
            Provider
          </label>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {providerOptions.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => setProvider(p.value)}
                className={clsx(
                  "flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-xs font-medium transition-colors cursor-pointer",
                  provider === p.value
                    ? "border-eidolon-500 bg-eidolon-500/10 text-eidolon-200"
                    : "border-border text-text-secondary hover:text-text-primary hover:border-border hover:bg-surface-overlay",
                )}
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-md bg-surface-overlay text-xs font-bold">
                  {PROVIDER_ICONS[p.value]}
                </span>
                <span className="truncate">{p.label}</span>
              </button>
            ))}
          </div>
        </div>

        <Select
          label="Model"
          options={modelOptions}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />

        <Input
          label="Monthly Budget ($)"
          type="number"
          placeholder="100"
          value={budgetDollars}
          onChange={(e) => setBudgetDollars(e.target.value)}
        />

        {agentOptions.length > 0 && (
          <Select
            label="Reports To"
            options={[
              { value: "", label: "None (top-level)" },
              ...agentOptions,
            ]}
            value={reportsTo}
            onChange={(e) => setReportsTo(e.target.value)}
          />
        )}

        <Textarea
          label="System Prompt / Instructions"
          placeholder="Define the agent's behavior and guidelines..."
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={3}
        />

        <Textarea
          label="Capabilities"
          placeholder="Comma-separated: TypeScript, React, Node.js"
          value={capabilities}
          onChange={(e) => setCapabilities(e.target.value)}
          rows={2}
        />

        {/* Advanced toggle */}
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
        >
          {showAdvanced ? "Hide" : "Show"} advanced settings
        </button>

        {showAdvanced && (
          <div className="space-y-4 rounded-lg border border-border bg-surface p-3">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-sm font-medium text-text-secondary">
                  Temperature
                </label>
                <span className="text-xs font-mono text-text-primary tabular-nums">
                  {parseFloat(temperature).toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="2"
                step="0.05"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                className="w-full h-1.5 rounded-full appearance-none bg-surface-overlay accent-eidolon-500 cursor-pointer"
              />
              <div className="flex justify-between mt-1">
                <span className="text-[10px] text-text-secondary">
                  Precise (0.0)
                </span>
                <span className="text-[10px] text-text-secondary">
                  Creative (2.0)
                </span>
              </div>
            </div>
            <Input
              label="Max Tokens"
              type="number"
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
              placeholder="4096"
            />
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            Hire Agent
          </Button>
        </div>
      </form>
    </Modal>
  );
}
