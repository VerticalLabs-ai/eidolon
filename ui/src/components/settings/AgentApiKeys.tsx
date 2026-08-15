// Agent API Key management section for company settings.
//
// Visible to admin/owner only (guarded by `apikeys.manage` permission).
// "Create API Key" opens a modal with a name input and role selector
// (default member). Submitting creates the key via POST and shows the raw
// key in a success modal with a copy button and "You won't see this again"
// warning. The key list shows name, key prefix, role, last used, and created
// date. A revoke button is present on each active key.
//
// Fulfills VAL-UI-019 through VAL-UI-024, VAL-CROSS-018.

import { useState } from 'react';
import { KeyRound, Plus, Trash2, Copy, Check, AlertTriangle, Clock } from 'lucide-react';
import { toast } from 'sonner';
import { useAgentApiKeys, useCreateAgentApiKey, useRevokeAgentApiKey } from '@/lib/hooks';
import { usePermission } from '@/lib/permissions';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import type { AgentApiKey, Role } from '@/lib/api';

const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Admin' },
];

const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

function formatDate(iso: string | null): string {
  if (!iso) {
    return '—';
  }
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    return iso;
  }
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(iso: string | null): string {
  if (!iso) {
    return '—';
  }
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    return iso;
  }
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function AgentApiKeys({ companyId }: { companyId: string }) {
  const { hasPermission } = usePermission(companyId);
  const canManage = hasPermission('apikeys.manage');

  const { data: keys = [], isLoading } = useAgentApiKeys(companyId, canManage);
  const createKey = useCreateAgentApiKey(companyId);
  const revokeKey = useRevokeAgentApiKey(companyId);

  // Create modal state
  const [createOpen, setCreateOpen] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [keyRole, setKeyRole] = useState<Role>('member');

  // Raw key success modal state
  const [createdKey, setCreatedKey] = useState<(AgentApiKey & { rawKey: string }) | null>(null);
  const [copied, setCopied] = useState(false);

  // Don't render anything if the user lacks permission (VAL-UI-020)
  if (!canManage) {
    return null;
  }

  const handleOpenCreate = () => {
    setKeyName('');
    setKeyRole('member');
    setCreateOpen(true);
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyName.trim()) {
      return;
    }
    createKey.mutate(
      { name: keyName.trim(), role: keyRole },
      {
        onSuccess: (result) => {
          setCreateOpen(false);
          setCreatedKey(result);
          setCopied(false);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : 'Failed to create API key');
        },
      },
    );
  };

  const handleCopyKey = async () => {
    if (!createdKey) {
      return;
    }
    try {
      await navigator.clipboard.writeText(createdKey.rawKey);
      setCopied(true);
      toast.success('API key copied to clipboard');
      setTimeout(() => setCopied(false), 3000);
    } catch {
      toast.error('Failed to copy key to clipboard');
    }
  };

  const handleCloseRawKeyModal = () => {
    setCreatedKey(null);
    setCopied(false);
  };

  const handleRevoke = (key: AgentApiKey) => {
    if (window.confirm(`Revoke the API key "${key.name}"? This cannot be undone.`)) {
      revokeKey.mutate(key.id, {
        onSuccess: () => toast.success('API key revoked'),
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : 'Failed to revoke API key'),
      });
    }
  };

  const activeKeys = keys.filter((k) => !k.revokedAt);
  const revokedKeys = keys.filter((k) => k.revokedAt);

  return (
    <>
      {/* Agent API Keys section */}
      <div className="glass rounded-xl overflow-hidden" data-section="agent-api-keys">
        <div className="px-6 py-4 border-b border-white/[0.06] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-neon-cyan" />
            <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
              Agent API Keys
            </h3>
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon={<Plus className="h-3.5 w-3.5" />}
            onClick={handleOpenCreate}
            data-action="create-api-key"
          >
            Create API Key
          </Button>
        </div>

        <div className="p-6 space-y-4">
          {isLoading ? (
            <div className="flex h-24 items-center justify-center">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
            </div>
          ) : activeKeys.length === 0 && revokedKeys.length === 0 ? (
            <div className="py-8 text-center">
              <KeyRound className="h-8 w-8 text-text-secondary/30 mx-auto mb-3" />
              <p className="text-sm text-text-secondary">No agent API keys yet.</p>
              <p className="text-xs text-text-secondary/60 mt-1">
                Create an API key to authenticate agents without a Clerk session.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {activeKeys.map((key) => (
                <KeyRow
                  key={key.id}
                  apiKey={key}
                  isRevoking={revokeKey.isPending}
                  onRevoke={() => handleRevoke(key)}
                />
              ))}
              {revokedKeys.length > 0 && (
                <>
                  <div className="pt-2 pb-1">
                    <p className="text-xs font-medium text-text-secondary uppercase tracking-wide">
                      Revoked
                    </p>
                  </div>
                  {revokedKeys.map((key) => (
                    <KeyRow key={key.id} apiKey={key} isRevoking={false} onRevoke={() => {}} />
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Create API Key modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create API Key"
        className="sm:max-w-md"
      >
        <form onSubmit={handleCreateSubmit} className="space-y-5">
          <Input
            label="Key Name"
            placeholder="e.g., Production Agent Key"
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            required
            autoFocus
          />
          <Select
            label="Role"
            value={keyRole}
            onChange={(e) => setKeyRole(e.target.value as Role)}
            options={ROLE_OPTIONS}
          />
          <p className="text-xs text-text-secondary">
            The key will have the permissions of the selected role. Default is Member.
          </p>
          <div className="flex items-center justify-end gap-3 pt-1">
            <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={createKey.isPending}>
              Create Key
            </Button>
          </div>
        </form>
      </Modal>

      {/* Raw key success modal */}
      <Modal
        open={!!createdKey}
        onClose={handleCloseRawKeyModal}
        title="API Key Created"
        className="sm:max-w-lg"
      >
        {createdKey && (
          <div className="space-y-5">
            {/* Warning */}
            <div
              className="flex items-start gap-3 rounded-xl p-4"
              style={{
                background: 'rgba(255, 215, 0, 0.06)',
                border: '1px solid rgba(255, 215, 0, 0.15)',
              }}
            >
              <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" />
              <div>
                <p className="text-sm font-medium text-amber-300">You won&apos;t see this again</p>
                <p className="text-xs text-amber-300/70 mt-1">
                  Copy this key now and store it securely. It will not be shown again.
                </p>
              </div>
            </div>

            {/* Key metadata */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-secondary w-16">Name</span>
                <span className="text-sm text-text-primary font-medium">{createdKey.name}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-secondary w-16">Role</span>
                <Badge variant="info">{ROLE_LABELS[createdKey.role]}</Badge>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-secondary w-16">Prefix</span>
                <span className="text-xs text-text-secondary font-mono">
                  {createdKey.keyPrefix}…
                </span>
              </div>
            </div>

            {/* Raw key display with copy button */}
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5 font-display">
                Raw Key
              </label>
              <div className="flex items-center gap-2">
                <code
                  className="flex-1 rounded-lg border border-white/[0.08] bg-surface/80 px-3 py-2 text-sm text-neon-cyan font-mono break-all select-all"
                  data-testid="raw-key"
                >
                  {createdKey.rawKey}
                </code>
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  icon={
                    copied ? (
                      <Check className="h-4 w-4 text-success" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )
                  }
                  onClick={handleCopyKey}
                  data-action="copy-key"
                >
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </div>

            <div className="flex items-center justify-end pt-1">
              <Button type="button" onClick={handleCloseRawKeyModal}>
                Done
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

function KeyRow({
  apiKey,
  isRevoking,
  onRevoke,
}: {
  apiKey: AgentApiKey;
  isRevoking: boolean;
  onRevoke: () => void;
}) {
  const isRevoked = !!apiKey.revokedAt;

  return (
    <div
      className={`flex items-center justify-between rounded-xl p-4 transition-all duration-200 ${
        isRevoked ? 'glass-raised opacity-60' : 'glass-raised hover:glass-hover'
      }`}
      data-key-id={apiKey.id}
      data-revoked={isRevoked}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className={`flex h-9 w-9 items-center justify-center rounded-xl shrink-0 ${
            isRevoked ? 'bg-text-secondary/10' : 'bg-neon-cyan/10'
          }`}
        >
          <KeyRound className={`h-4 w-4 ${isRevoked ? 'text-text-secondary' : 'text-neon-cyan'}`} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-text-primary truncate">{apiKey.name}</p>
            <Badge variant={isRevoked ? 'default' : 'info'}>{ROLE_LABELS[apiKey.role]}</Badge>
            {isRevoked && <Badge variant="error">Revoked</Badge>}
          </div>
          <div className="flex items-center gap-3 mt-0.5">
            <span className="text-xs text-text-secondary font-mono">{apiKey.keyPrefix}…</span>
            <span className="text-xs text-text-secondary/60 flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Last used {formatDate(apiKey.lastUsedAt)}
            </span>
            <span className="text-xs text-text-secondary/60">
              Created {formatDate(apiKey.createdAt)}
            </span>
          </div>
        </div>
      </div>

      {/* Revoke button — only for active keys */}
      {!isRevoked && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onRevoke}
          loading={isRevoking}
          className="shrink-0 text-error hover:text-error"
          data-action="revoke-key"
          aria-label={`Revoke API key ${apiKey.name}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Revoke
        </Button>
      )}
    </div>
  );
}
