import { useState } from "react";
import { useParams } from "react-router-dom";
import {
  Plug,
  Plus,
  Trash2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ExternalLink,
  Zap,
  GitBranch,
  MessageSquare,
  BookOpen,
  ListChecks,
  Mail,
  Calendar,
  CreditCard,
  Users,
  Globe,
  Webhook,
  X,
  Loader2,
} from "lucide-react";
import { clsx } from "clsx";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import {
  useIntegrations,
  useCreateIntegration,
  useDeleteIntegration,
  useTestIntegration,
} from "@/lib/hooks";
import type { IntegrationCatalogItem, Integration } from "@/lib/api";

// ---------------------------------------------------------------------------
// Icon map for integration types
// ---------------------------------------------------------------------------

const INTEGRATION_ICONS: Record<string, typeof Plug> = {
  github: GitBranch,
  slack: MessageSquare,
  notion: BookOpen,
  linear: ListChecks,
  gmail: Mail,
  calendar: Calendar,
  stripe: CreditCard,
  hubspot: Users,
  custom_api: Globe,
  webhook_out: Webhook,
};

function getIntegrationIcon(type: string) {
  return INTEGRATION_ICONS[type] ?? Plug;
}

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, { icon: typeof CheckCircle2; color: string; label: string }> = {
    active: { icon: CheckCircle2, color: "text-emerald-400", label: "Active" },
    inactive: { icon: XCircle, color: "text-text-secondary", label: "Inactive" },
    error: { icon: AlertCircle, color: "text-red-400", label: "Error" },
  };
  const v = variants[status] ?? variants.inactive;
  const Icon = v.icon;

  return (
    <span className={clsx("flex items-center gap-1 text-[10px] font-medium", v.color)}>
      <Icon className="h-3 w-3" />
      {v.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Connect modal
// ---------------------------------------------------------------------------

function ConnectModal({
  item,
  onClose,
  onConnect,
  isLoading,
}: {
  item: IntegrationCatalogItem;
  onClose: () => void;
  onConnect: (config: Record<string, string>, credentials?: string) => void;
  isLoading: boolean;
}) {
  const [fields, setFields] = useState<Record<string, string>>(
    Object.fromEntries(item.configFields.map((f) => [f, ""])),
  );

  const Icon = getIntegrationIcon(item.type);
  const isSensitiveField = (f: string) =>
    ["token", "apiKey", "secretKey", "botToken", "credentials", "secret"].includes(f);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Separate credentials from config
    const config: Record<string, string> = {};
    let credentials: string | undefined;

    for (const [key, value] of Object.entries(fields)) {
      if (isSensitiveField(key) && value) {
        credentials = value;
      } else {
        config[key] = value;
      }
    }

    onConnect(config, credentials);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="glass rounded-xl border border-white/[0.08] p-6 w-full max-w-md mx-4">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/10">
              <Icon className="h-4 w-4 text-amber-400" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-text-primary font-display">
                Connect {item.name}
              </h3>
              <p className="text-[10px] text-text-secondary">
                {item.description}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-text-secondary hover:text-text-primary hover:bg-white/[0.05] transition-colors cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          {item.configFields.map((field) => (
            <Input
              key={field}
              label={field
                .replace(/([A-Z])/g, " $1")
                .replace(/^./, (s) => s.toUpperCase())}
              value={fields[field]}
              onChange={(e) =>
                setFields((prev) => ({ ...prev, [field]: e.target.value }))
              }
              type={isSensitiveField(field) ? "password" : "text"}
              placeholder={`Enter ${field}`}
            />
          ))}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={onClose} type="button">
              Cancel
            </Button>
            <Button size="sm" type="submit" loading={isLoading}>
              Connect
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function Integrations() {
  const { companyId } = useParams();
  const { data: integrationsData } = useIntegrations(companyId);
  const createIntegration = useCreateIntegration(companyId!);
  const deleteIntegration = useDeleteIntegration(companyId!);
  const testIntegration = useTestIntegration(companyId!);

  const [connectItem, setConnectItem] = useState<IntegrationCatalogItem | null>(
    null,
  );
  const [testResults, setTestResults] = useState<
    Record<string, { success: boolean; message: string } | "loading">
  >({});

  const connected = integrationsData?.data ?? [];
  const catalog = integrationsData?.catalog ?? [];
  const connectedTypes = new Set(connected.map((c) => c.type));

  const handleConnect = (
    item: IntegrationCatalogItem,
    config: Record<string, string>,
    credentials?: string,
  ) => {
    createIntegration.mutate(
      {
        name: item.name,
        type: item.type,
        provider: item.provider,
        config,
        credentials,
      },
      {
        onSuccess: () => setConnectItem(null),
      },
    );
  };

  const handleTest = (integrationId: string) => {
    setTestResults((prev) => ({ ...prev, [integrationId]: "loading" }));
    testIntegration.mutate(integrationId, {
      onSuccess: (res) => {
        const data = (res as any)?.data ?? res;
        setTestResults((prev) => ({
          ...prev,
          [integrationId]: {
            success: data.success,
            message: data.message,
          },
        }));
      },
      onError: () => {
        setTestResults((prev) => ({
          ...prev,
          [integrationId]: { success: false, message: "Test failed" },
        }));
      },
    });
  };

  const handleDelete = (integrationId: string) => {
    if (!window.confirm("Remove this integration?")) return;
    deleteIntegration.mutate(integrationId);
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-text-primary font-display">
          Integrations
        </h1>
        <p className="text-sm text-text-secondary mt-1">
          Connect external services for your agents to use as tools during
          execution.
        </p>
      </div>

      {/* Connected integrations */}
      {connected.length > 0 && (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-text-secondary font-display mb-3">
            Connected ({connected.length})
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {connected.map((integration) => {
              const Icon = getIntegrationIcon(integration.type);
              const testResult = testResults[integration.id];

              return (
                <Card key={integration.id} className="group">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10 shrink-0">
                        <Icon className="h-5 w-5 text-amber-400" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-sm font-medium text-text-primary font-display truncate">
                          {integration.name}
                        </h3>
                        <div className="flex items-center gap-2 mt-0.5">
                          <StatusBadge status={integration.status} />
                          <span className="text-[10px] text-text-secondary">
                            {integration.provider}
                          </span>
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => handleDelete(integration.id)}
                      className="p-1 rounded-md text-text-secondary/40 hover:text-red-400 hover:bg-red-500/10 transition-colors opacity-0 group-hover:opacity-100 cursor-pointer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <div className="mt-3 flex items-center gap-4 text-[10px] text-text-secondary">
                    {integration.usageCount > 0 && (
                      <span className="flex items-center gap-1">
                        <Zap className="h-3 w-3" />
                        {integration.usageCount} uses
                      </span>
                    )}
                    {integration.lastUsedAt && (
                      <span>Last used {formatDate(integration.lastUsedAt)}</span>
                    )}
                    <span>Added {formatDate(integration.createdAt)}</span>
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleTest(integration.id)}
                      disabled={testResult === "loading"}
                    >
                      {testResult === "loading" ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Testing...
                        </>
                      ) : (
                        "Test Connection"
                      )}
                    </Button>

                    {testResult && testResult !== "loading" && (
                      <span
                        className={clsx(
                          "text-[10px] font-medium flex items-center gap-1",
                          testResult.success
                            ? "text-emerald-400"
                            : "text-red-400",
                        )}
                      >
                        {testResult.success ? (
                          <CheckCircle2 className="h-3 w-3" />
                        ) : (
                          <XCircle className="h-3 w-3" />
                        )}
                        {testResult.message}
                      </span>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        </section>
      )}

      {/* Integration catalog */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-text-secondary font-display mb-3">
          Available Integrations
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {catalog.map((item) => {
            const Icon = getIntegrationIcon(item.type);
            const isConnected = connectedTypes.has(item.type);

            return (
              <div
                key={item.type}
                className={clsx(
                  "glass rounded-xl border p-4 transition-all duration-300",
                  isConnected
                    ? "border-amber-500/20 bg-amber-500/[0.03]"
                    : "border-white/[0.06] hover:border-white/[0.12] hover:bg-white/[0.02]",
                )}
              >
                <div className="flex items-start gap-3">
                  <div
                    className={clsx(
                      "flex h-10 w-10 items-center justify-center rounded-lg shrink-0",
                      isConnected
                        ? "bg-amber-500/15"
                        : "bg-white/[0.06]",
                    )}
                  >
                    <Icon
                      className={clsx(
                        "h-5 w-5",
                        isConnected
                          ? "text-amber-400"
                          : "text-text-secondary",
                      )}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-medium text-text-primary font-display">
                        {item.name}
                      </h3>
                      {isConnected && (
                        <Badge variant="success">Connected</Badge>
                      )}
                    </div>
                    <p className="text-[11px] text-text-secondary mt-0.5">
                      {item.description}
                    </p>
                    <p className="text-[10px] text-text-secondary/50 mt-1">
                      Provider: {item.provider}
                    </p>
                  </div>
                </div>

                <div className="mt-3">
                  {isConnected ? (
                    <Button variant="ghost" size="sm" disabled>
                      <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                      Connected
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setConnectItem(item)}
                      icon={<Plus className="h-3 w-3" />}
                    >
                      Connect
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Connect modal */}
      {connectItem && (
        <ConnectModal
          item={connectItem}
          onClose={() => setConnectItem(null)}
          onConnect={(config, credentials) =>
            handleConnect(connectItem, config, credentials)
          }
          isLoading={createIntegration.isPending}
        />
      )}
    </div>
  );
}
