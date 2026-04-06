import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import {
  Save,
  AlertTriangle,
  Pause,
  Archive,
  Plus,
  Trash2,
  Key,
  Eye,
  EyeOff,
  CheckCircle2,
  DollarSign,
  Play,
} from "lucide-react";
import {
  useCompany,
  useUpdateCompany,
  useSecrets,
  useCreateSecret,
  useDeleteSecret,
} from "@/lib/hooks";
import { Input, Textarea, Select } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { PageTransition } from "@/components/ui/PageTransition";

const PROVIDER_OPTIONS = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "google", label: "Google" },
  { value: "mistral", label: "Mistral" },
  { value: "custom", label: "Custom" },
];

export function CompanySettings() {
  const { companyId } = useParams();
  const { data: company } = useCompany(companyId);
  const updateCompany = useUpdateCompany();
  const { data: secrets } = useSecrets(companyId);
  const createSecret = useCreateSecret(companyId!);
  const deleteSecret = useDeleteSecret(companyId!);

  // General form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mission, setMission] = useState("");
  const [brandColor, setBrandColor] = useState("#4c6ef5");
  const [generalSaved, setGeneralSaved] = useState(false);

  // Budget form state
  const [budgetDollars, setBudgetDollars] = useState("");
  const [alertThreshold, setAlertThreshold] = useState("80");
  const [budgetSaved, setBudgetSaved] = useState(false);

  // Secret form state
  const [showAddKey, setShowAddKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyProvider, setNewKeyProvider] = useState("anthropic");
  const [newKeyValue, setNewKeyValue] = useState("");
  const [newKeyDescription, setNewKeyDescription] = useState("");

  useEffect(() => {
    if (company) {
      setName(company.name);
      setDescription(company.description ?? "");
      setMission(company.mission ?? "");
      setBrandColor(company.brandColor ?? "#4c6ef5");
      setBudgetDollars(String((company.budgetMonthlyCents ?? 0) / 100));
      setAlertThreshold(
        String(
          (company.settings?.alertThresholdPercent as number) ?? 80,
        ),
      );
    }
  }, [company]);

  const handleSaveGeneral = (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyId) return;
    updateCompany.mutate(
      {
        id: companyId,
        data: { name, description, mission },
      },
      {
        onSuccess: () => {
          setGeneralSaved(true);
          setTimeout(() => setGeneralSaved(false), 2000);
        },
      },
    );
  };

  const handleSaveBudget = () => {
    if (!companyId) return;
    updateCompany.mutate(
      {
        id: companyId,
        data: {
          budgetMonthlyCents: Math.round(
            parseFloat(budgetDollars || "0") * 100,
          ),
        },
      },
      {
        onSuccess: () => {
          setBudgetSaved(true);
          setTimeout(() => setBudgetSaved(false), 2000);
        },
      },
    );
  };

  const handleAddKey = (e: React.FormEvent) => {
    e.preventDefault();
    createSecret.mutate(
      {
        name: newKeyName,
        value: newKeyValue,
        provider: newKeyProvider,
        description: newKeyDescription || undefined,
      },
      {
        onSuccess: () => {
          setNewKeyName("");
          setNewKeyProvider("anthropic");
          setNewKeyValue("");
          setNewKeyDescription("");
          setShowAddKey(false);
        },
      },
    );
  };

  const handleDeleteKey = (secretId: string, secretName: string) => {
    if (
      window.confirm(
        `Are you sure you want to delete the API key "${secretName}"? This cannot be undone.`,
      )
    ) {
      deleteSecret.mutate(secretId);
    }
  };

  const handleStatusChange = (status: "active" | "paused" | "archived") => {
    if (!companyId) return;
    const confirmMsg =
      status === "archived"
        ? "Are you sure you want to archive this company? This action cannot be easily undone."
        : status === "paused"
          ? "Are you sure you want to pause this company? All agents will stop working."
          : "Resume this company?";

    if (window.confirm(confirmMsg)) {
      updateCompany.mutate({ id: companyId, data: { status } });
    }
  };

  return (
    <PageTransition>
    <div className="mx-auto max-w-2xl p-6 lg:p-8 space-y-8">
      <div>
        <h2 className="font-display text-2xl font-bold text-text-primary tracking-tight">
          Settings
        </h2>
        <p className="text-sm text-text-secondary mt-1">
          Manage company configuration
        </p>
      </div>

      {/* General */}
      <form onSubmit={handleSaveGeneral}>
        <div className="glass rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.06]">
            <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
              General
            </h3>
          </div>
          <div className="p-6 space-y-5">
            <Input
              label="Company Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <Textarea
              label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
            <Textarea
              label="Mission"
              value={mission}
              onChange={(e) => setMission(e.target.value)}
              rows={3}
            />
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-2">
                Brand Color
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={brandColor}
                  onChange={(e) => setBrandColor(e.target.value)}
                  className="h-10 w-14 rounded-lg border border-white/[0.06] bg-surface-raised cursor-pointer"
                />
                <Input
                  value={brandColor}
                  onChange={(e) => setBrandColor(e.target.value)}
                  className="flex-1 font-mono"
                  placeholder="#4c6ef5"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 pt-2">
              {generalSaved && (
                <span className="text-sm text-success flex items-center gap-1.5">
                  <CheckCircle2 className="h-4 w-4" />
                  Saved
                </span>
              )}
              <Button
                type="submit"
                icon={<Save className="h-4 w-4" />}
                loading={updateCompany.isPending}
              >
                Save Changes
              </Button>
            </div>
          </div>
        </div>
      </form>

      {/* Budget */}
      <div className="glass rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-white/[0.06]">
          <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
            Budget
          </h3>
        </div>
        <div className="p-6 space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label="Monthly Budget ($)"
              type="number"
              value={budgetDollars}
              onChange={(e) => setBudgetDollars(e.target.value)}
              placeholder="1000"
            />
            <Input
              label="Alert Threshold (%)"
              type="number"
              min="0"
              max="100"
              value={alertThreshold}
              onChange={(e) => setAlertThreshold(e.target.value)}
              placeholder="80"
            />
          </div>

          <div className="glass-raised rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-secondary">
                Monthly Budget
              </span>
              <span className="text-xs font-semibold text-text-primary tabular-nums font-display">
                $
                {(
                  (company?.budgetMonthlyCents ?? 0) / 100
                ).toLocaleString()}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-secondary">Spent</span>
              <span className="text-xs font-semibold text-text-primary tabular-nums font-display">
                $
                {(
                  (company?.spentMonthlyCents ?? 0) / 100
                ).toLocaleString()}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-secondary">Remaining</span>
              <span className="text-xs font-semibold text-success tabular-nums font-display">
                $
                {(
                  ((company?.budgetMonthlyCents ?? 0) -
                    (company?.spentMonthlyCents ?? 0)) /
                  100
                ).toLocaleString()}
              </span>
            </div>
            {/* Progress bar */}
            <div className="h-2 rounded-full bg-surface-overlay mt-2 overflow-hidden">
              <div
                className="h-full rounded-full bg-accent transition-all duration-500 ease-out"
                style={{
                  width: `${Math.min(
                    100,
                    company?.budgetMonthlyCents
                      ? ((company.spentMonthlyCents ?? 0) /
                          company.budgetMonthlyCents) *
                        100
                      : 0,
                  )}%`,
                }}
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-3">
            {budgetSaved && (
              <span className="text-sm text-success flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4" />
                Saved
              </span>
            )}
            <Button
              icon={<Save className="h-4 w-4" />}
              onClick={handleSaveBudget}
              loading={updateCompany.isPending}
            >
              Save Budget
            </Button>
          </div>
        </div>
      </div>

      {/* API Keys */}
      <div className="glass rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-white/[0.06] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Key className="h-4 w-4 text-neon-cyan" />
            <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
              API Keys
            </h3>
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon={<Plus className="h-3.5 w-3.5" />}
            onClick={() => setShowAddKey(!showAddKey)}
          >
            Add Key
          </Button>
        </div>
        <div className="p-6 space-y-4">
          {/* Add key form */}
          {showAddKey && (
            <form
              onSubmit={handleAddKey}
              className="rounded-xl glass-raised p-5 space-y-4"
            >
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Input
                  label="Key Name"
                  placeholder="e.g., Production Claude Key"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  required
                />
                <Select
                  label="Provider"
                  options={PROVIDER_OPTIONS}
                  value={newKeyProvider}
                  onChange={(e) => setNewKeyProvider(e.target.value)}
                />
              </div>
              <Input
                label="API Key"
                type="password"
                placeholder="sk-..."
                value={newKeyValue}
                onChange={(e) => setNewKeyValue(e.target.value)}
                required
              />
              <Input
                label="Description (optional)"
                placeholder="What this key is used for"
                value={newKeyDescription}
                onChange={(e) => setNewKeyDescription(e.target.value)}
              />
              <div className="flex items-center justify-end gap-3 pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowAddKey(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  loading={createSecret.isPending}
                >
                  Save Key
                </Button>
              </div>
            </form>
          )}

          {/* Existing keys list */}
          {!secrets?.length && !showAddKey ? (
            <div className="py-8 text-center">
              <Key className="h-8 w-8 text-text-secondary/30 mx-auto mb-3" />
              <p className="text-sm text-text-secondary">
                No API keys configured yet.
              </p>
              <p className="text-xs text-text-secondary/60 mt-1">
                Add API keys to assign them to agents.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {(secrets ?? []).map((secret) => (
                <div
                  key={secret.id}
                  className="flex items-center justify-between rounded-xl glass-raised p-4 transition-all duration-200 hover:glass-hover"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-neon-cyan/10 shrink-0">
                      <Key className="h-4 w-4 text-neon-cyan" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-text-primary truncate">
                          {secret.name}
                        </p>
                        <Badge variant="default">{secret.provider}</Badge>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-text-secondary font-mono">
                          --------{secret.lastFourChars ?? "????"}
                        </span>
                        {secret.description && (
                          <span className="text-xs text-text-secondary/60 truncate">
                            {secret.description}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDeleteKey(secret.id, secret.name)}
                    className="shrink-0 text-error hover:text-error"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Danger Zone */}
      <div className="rounded-xl overflow-hidden border border-error/20" style={{ background: "rgba(255,68,102,0.03)" }}>
        <div className="px-6 py-4 border-b border-error/15 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-error" />
          <h3 className="font-display text-sm font-semibold text-error tracking-wide">
            Danger Zone
          </h3>
        </div>
        <div className="p-6 space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-text-primary">
                Pause Company
              </p>
              <p className="text-xs text-text-secondary mt-0.5">
                Temporarily stop all agent activity.
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              icon={
                company?.status === "paused" ? (
                  <Play className="h-3.5 w-3.5" />
                ) : (
                  <Pause className="h-3.5 w-3.5" />
                )
              }
              onClick={() =>
                handleStatusChange(
                  company?.status === "paused" ? "active" : "paused",
                )
              }
            >
              {company?.status === "paused" ? "Resume" : "Pause"}
            </Button>
          </div>

          <div className="border-t border-error/10" />

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-text-primary">
                Archive Company
              </p>
              <p className="text-xs text-text-secondary mt-0.5">
                Permanently archive this company and all its data.
              </p>
            </div>
            <Button
              variant="danger"
              size="sm"
              icon={<Archive className="h-3.5 w-3.5" />}
              onClick={() => handleStatusChange("archived")}
            >
              Archive
            </Button>
          </div>
        </div>
      </div>
    </div>
    </PageTransition>
  );
}
