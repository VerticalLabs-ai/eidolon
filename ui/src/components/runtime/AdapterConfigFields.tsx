import { useEffect, useState } from "react";
import { clsx } from "clsx";
import { Input } from "@/components/ui/Input";
import type { RuntimeAdapterConfigField } from "@/lib/api";
import type { RuntimeAdapterConfig } from "@/lib/runtime-adapters";

interface AdapterConfigFieldsProps {
  fields: readonly RuntimeAdapterConfigField[];
  value: RuntimeAdapterConfig;
  onChange: (value: RuntimeAdapterConfig) => void;
  disabled?: boolean;
}

function stringListValue(value: unknown): string {
  return Array.isArray(value) ? value.join(", ") : "";
}

function replaceValue(
  current: RuntimeAdapterConfig,
  field: RuntimeAdapterConfigField,
  value: string | boolean,
): RuntimeAdapterConfig {
  if (field.type === "boolean") {
    return { ...current, [field.key]: value };
  }
  if (field.type === "number") {
    return {
      ...current,
      [field.key]: value === "" ? "" : Number(value),
    };
  }
  if (field.type === "string-list") {
    return {
      ...current,
      [field.key]: String(value)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    };
  }
  return { ...current, [field.key]: value };
}

export function AdapterConfigFields({
  fields,
  value,
  onChange,
  disabled = false,
}: AdapterConfigFieldsProps) {
  const [listDrafts, setListDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields
        .filter((field) => field.type === "string-list")
        .map((field) => [field.key, stringListValue(value[field.key])]),
    ),
  );

  useEffect(() => {
    setListDrafts(
      Object.fromEntries(
        fields
          .filter((field) => field.type === "string-list")
          .map((field) => [field.key, stringListValue(value[field.key])]),
      ),
    );
  }, [fields, value]);

  if (fields.length === 0) return null;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {fields.map((field) => {
        const fieldId = `adapter-config-${field.key}`;
        if (field.type === "boolean") {
          return (
            <label
              key={field.key}
              htmlFor={fieldId}
              className="flex min-h-16 items-center justify-between gap-4 rounded-lg border border-white/[0.08] bg-surface/60 px-3 py-2.5"
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium text-text-primary/90 font-display">
                  {field.label}
                </span>
                {field.description ? (
                  <span className="mt-0.5 block text-xs text-text-primary/70">
                    {field.description}
                  </span>
                ) : null}
              </span>
              <input
                id={fieldId}
                type="checkbox"
                checked={
                  value[field.key] === undefined
                    ? field.defaultValue === true
                    : value[field.key] === true
                }
                disabled={disabled}
                onChange={(event) =>
                  onChange(replaceValue(value, field, event.target.checked))
                }
                className="h-4 w-4 shrink-0 accent-neon-cyan disabled:opacity-40"
              />
            </label>
          );
        }

        const displayValue =
          field.type === "string-list"
            ? (listDrafts[field.key] ?? stringListValue(value[field.key]))
            : String(value[field.key] ?? "");

        return (
          <div
            key={field.key}
            className={clsx(
              "space-y-1.5",
              field.type === "url" && "sm:col-span-2",
            )}
          >
            <label
              htmlFor={fieldId}
              className="block text-sm font-medium text-text-primary/90 font-display"
            >
              {field.label}
            </label>
            <Input
              id={fieldId}
              type={field.type === "number" ? "number" : field.type === "url" ? "url" : "text"}
              value={displayValue}
              min={field.min}
              max={field.max}
              required={field.required}
              disabled={disabled}
              placeholder={field.placeholder}
              onChange={(event) => {
                if (field.type === "string-list") {
                  setListDrafts((current) => ({
                    ...current,
                    [field.key]: event.target.value,
                  }));
                  return;
                }
                onChange(replaceValue(value, field, event.target.value));
              }}
              onBlur={() => {
                if (field.type === "string-list") {
                  onChange(
                    replaceValue(value, field, listDrafts[field.key] ?? ""),
                  );
                }
              }}
              onKeyDown={(event) => {
                if (field.type === "string-list" && event.key === "Enter") {
                  event.preventDefault();
                  onChange(
                    replaceValue(value, field, listDrafts[field.key] ?? ""),
                  );
                }
              }}
            />
            {field.description ? (
              <p className="text-xs text-text-primary/70">{field.description}</p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
