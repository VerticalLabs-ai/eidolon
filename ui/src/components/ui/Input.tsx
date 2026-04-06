import { clsx } from "clsx";
import type {
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  SelectHTMLAttributes,
  ReactNode,
} from "react";

// ── Text Input ───────────────────────────────────────────────────────────

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

const inputBase =
  "w-full rounded-lg border border-white/[0.08] bg-surface/80 backdrop-blur-sm px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/40 outline-none transition-all duration-300 focus:border-neon-cyan/40 focus:shadow-[0_0_15px_rgba(0,243,255,0.1)] disabled:opacity-40";

export function Input({ label, error, className, id, ...props }: InputProps) {
  const inputId = id || label?.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="space-y-1.5">
      {label && (
        <label
          htmlFor={inputId}
          className="block text-sm font-medium text-text-secondary font-display"
        >
          {label}
        </label>
      )}
      <input id={inputId} className={clsx(inputBase, className)} {...props} />
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}

// ── Textarea ─────────────────────────────────────────────────────────────

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

export function Textarea({ label, error, className, id, ...props }: TextareaProps) {
  const inputId = id || label?.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="space-y-1.5">
      {label && (
        <label
          htmlFor={inputId}
          className="block text-sm font-medium text-text-secondary font-display"
        >
          {label}
        </label>
      )}
      <textarea
        id={inputId}
        className={clsx(inputBase, "min-h-[80px] resize-y", className)}
        {...props}
      />
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}

// ── Select ───────────────────────────────────────────────────────────────

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options: { value: string; label: string }[];
  placeholder?: string;
  icon?: ReactNode;
}

export function Select({
  label,
  error,
  options,
  placeholder,
  className,
  id,
  ...props
}: SelectProps) {
  const inputId = id || label?.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="space-y-1.5">
      {label && (
        <label
          htmlFor={inputId}
          className="block text-sm font-medium text-text-secondary font-display"
        >
          {label}
        </label>
      )}
      <select
        id={inputId}
        className={clsx(inputBase, "appearance-none cursor-pointer", className)}
        {...props}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}
