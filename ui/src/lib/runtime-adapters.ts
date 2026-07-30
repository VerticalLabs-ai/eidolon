import type {
  RuntimeAdapterConfigField,
  RuntimeAdapterDescriptor,
} from "@/lib/api";

export type RuntimeAdapterConfig = Record<string, unknown>;

function fieldDefault(field: RuntimeAdapterConfigField): unknown {
  if (field.defaultValue !== undefined) return field.defaultValue;
  if (field.type === "boolean") return false;
  if (field.type === "string-list") return [];
  return "";
}

export function configForAdapter(
  adapter: RuntimeAdapterDescriptor | undefined,
  current: RuntimeAdapterConfig | null | undefined,
): RuntimeAdapterConfig {
  if (!adapter) return {};

  const configured = { ...(current ?? {}) };
  for (const field of adapter.configFields ?? []) {
    configured[field.key] = current?.[field.key] ?? fieldDefault(field);
  }
  return configured;
}

export function validateAdapterConfig(
  adapter: RuntimeAdapterDescriptor | undefined,
  config: RuntimeAdapterConfig,
): string | null {
  if (!adapter) return null;

  for (const field of adapter.configFields ?? []) {
    const value = config[field.key];
    if (
      field.required &&
      (value === undefined || value === null || String(value).trim() === "")
    ) {
      return `${field.label} is required for ${adapter.name}.`;
    }

    if (field.type === "url" && typeof value === "string" && value.trim()) {
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return `${field.label} must use http or https.`;
        }
      } catch {
        return `${field.label} must be a valid URL.`;
      }
    }

    if (field.type === "number" && value !== "" && value !== undefined) {
      const numberValue = Number(value);
      if (!Number.isFinite(numberValue)) return `${field.label} must be a number.`;
      if (field.min !== undefined && numberValue < field.min) {
        return `${field.label} must be at least ${field.min}.`;
      }
      if (field.max !== undefined && numberValue > field.max) {
        return `${field.label} must be at most ${field.max}.`;
      }
    }
  }

  return null;
}
