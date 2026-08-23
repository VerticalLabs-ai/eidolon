import { useMemo, useState } from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';
import type { MissionQuestionDefinition } from '@/lib/api';
import {
  asOptions,
  asScaleValidation,
  asNumberValidation,
  asTextValidation,
  asChoiceValidation,
  controlClasses,
} from './mission-question-helpers';

/** Register the first invalid field's focusable element. */
export type InvalidRefRegistrar = (el: HTMLElement | null) => void;

/**
 * Render the type-specific input control for a Mission question.
 *
 * Each control is a native semantic input (radio group, checkbox group,
 * textarea, number input, range slider, or ordered list with non-drag move
 * controls) with explicit `aria-label`/`aria-describedby` associations so
 * help and errors are announced to assistive technology (VAL-MODEQ-053,
 * VAL-MODEQ-095). Ordering provides keyboard- and touch-operable move
 * controls so drag is never the only way to reorder (VAL-MODEQ-094).
 */
export function QuestionControl({
  question,
  value,
  disabled,
  helpId,
  errorId,
  labelId,
  onChange,
  invalidRef,
  hasError,
}: {
  question: MissionQuestionDefinition;
  value: unknown;
  disabled: boolean;
  helpId: string;
  errorId: string;
  labelId: string;
  onChange: (value: unknown) => void;
  invalidRef: InvalidRefRegistrar;
  hasError: boolean;
}) {
  const describedBy =
    [question.help ? helpId : null, hasError ? errorId : null].filter(Boolean).join(' ') ||
    undefined;
  const setRef = (el: HTMLElement | null) => {
    invalidRef(el);
  };

  switch (question.type) {
    case 'boolean':
      return (
        <BooleanControl
          question={question}
          value={value}
          disabled={disabled}
          describedBy={describedBy}
          labelId={labelId}
          onChange={onChange}
          setRef={setRef}
          hasError={hasError}
        />
      );
    case 'single_choice':
      return (
        <SingleChoiceControl
          question={question}
          value={value}
          disabled={disabled}
          describedBy={describedBy}
          labelId={labelId}
          onChange={onChange}
          setRef={setRef}
          hasError={hasError}
        />
      );
    case 'multiple_choice':
      return (
        <MultipleChoiceControl
          question={question}
          value={value}
          disabled={disabled}
          describedBy={describedBy}
          labelId={labelId}
          onChange={onChange}
          setRef={setRef}
          hasError={hasError}
        />
      );
    case 'text':
      return (
        <TextControl
          question={question}
          value={value}
          disabled={disabled}
          describedBy={describedBy}
          onChange={onChange}
          setRef={setRef}
          hasError={hasError}
        />
      );
    case 'number':
      return (
        <NumberControl
          question={question}
          value={value}
          disabled={disabled}
          describedBy={describedBy}
          onChange={onChange}
          setRef={setRef}
          hasError={hasError}
        />
      );
    case 'scale':
      return (
        <ScaleControl
          question={question}
          value={value}
          disabled={disabled}
          describedBy={describedBy}
          onChange={onChange}
          setRef={setRef}
          hasError={hasError}
        />
      );
    case 'ordering':
      return (
        <OrderingControl
          question={question}
          value={value}
          disabled={disabled}
          describedBy={describedBy}
          onChange={onChange}
          setRef={setRef}
          hasError={hasError}
        />
      );
    default:
      return (
        <p className="text-xs text-error" role="alert">
          Unknown question type: {question.type}
        </p>
      );
  }
}

type ControlProps = {
  question: MissionQuestionDefinition;
  value: unknown;
  disabled: boolean;
  describedBy?: string;
  onChange: (v: unknown) => void;
  setRef: InvalidRefRegistrar;
  hasError: boolean;
};

function BooleanControl({
  question,
  value,
  disabled,
  describedBy,
  labelId,
  onChange,
  setRef,
  hasError,
}: ControlProps & { labelId: string }) {
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      aria-required={question.required || undefined}
      aria-invalid={hasError || undefined}
      className="flex flex-wrap gap-4"
    >
      {[
        { v: true, label: 'Yes' },
        { v: false, label: 'No' },
      ].map((opt, i) => {
        const id = `q-${question.questionKey}-${opt.v}`;
        const checked = value === opt.v;
        return (
          <span key={String(opt.v)} className="inline-flex items-center gap-1.5">
            <input
              id={id}
              ref={i === 0 ? setRef : undefined}
              type="radio"
              name={`q-${question.questionKey}`}
              value={String(opt.v)}
              checked={checked}
              disabled={disabled}
              onChange={() => onChange(opt.v)}
              className={controlClasses(hasError).replace('w-full ', '')}
              aria-label={opt.label}
            />
            <label htmlFor={id} className="text-sm text-text-primary">
              {opt.label}
            </label>
          </span>
        );
      })}
    </div>
  );
}

function SingleChoiceControl({
  question,
  value,
  disabled,
  describedBy,
  labelId,
  onChange,
  setRef,
  hasError,
}: ControlProps & { labelId: string }) {
  const options = asOptions(question.options);
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      aria-required={question.required || undefined}
      aria-invalid={hasError || undefined}
      className="space-y-1"
    >
      {options.map((opt, i) => {
        const id = `q-${question.questionKey}-${opt.key}`;
        const checked = value === opt.key;
        return (
          <div key={opt.key} className="flex items-center gap-2">
            <input
              id={id}
              ref={i === 0 ? setRef : undefined}
              type="radio"
              name={`q-${question.questionKey}`}
              value={opt.key}
              checked={checked}
              disabled={disabled}
              onChange={() => onChange(opt.key)}
              className={controlClasses(hasError).replace('w-full ', '')}
              aria-label={opt.label}
            />
            <label htmlFor={id} className="text-sm text-text-primary break-words">
              {opt.label}
            </label>
          </div>
        );
      })}
    </div>
  );
}

function MultipleChoiceControl({
  question,
  value,
  disabled,
  describedBy,
  labelId,
  onChange,
  setRef,
  hasError,
}: ControlProps & { labelId: string }) {
  const options = asOptions(question.options);
  const selected = Array.isArray(value) ? (value as string[]) : [];
  const validation = asChoiceValidation(question.validation);
  const max = validation?.maxSelections;

  function toggle(key: string) {
    const set = new Set(selected);
    if (set.has(key)) {
      set.delete(key);
    } else if (max === undefined || set.size < max) {
      set.add(key);
    }
    onChange(Array.from(set));
  }

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      aria-required={question.required || undefined}
      aria-invalid={hasError || undefined}
      className="space-y-1"
    >
      {options.map((opt, i) => {
        const id = `q-${question.questionKey}-${opt.key}`;
        const checked = selected.includes(opt.key);
        const overMax = max !== undefined && !checked && selected.length >= max;
        return (
          <div key={opt.key} className="flex items-center gap-2">
            <input
              id={id}
              ref={i === 0 ? setRef : undefined}
              type="checkbox"
              name={`q-${question.questionKey}`}
              value={opt.key}
              checked={checked}
              disabled={disabled || overMax}
              onChange={() => toggle(opt.key)}
              className={controlClasses(hasError).replace('w-full ', '')}
              aria-label={opt.label}
            />
            <label htmlFor={id} className="text-sm text-text-primary break-words">
              {opt.label}
            </label>
          </div>
        );
      })}
    </div>
  );
}

function TextControl({
  question,
  value,
  disabled,
  describedBy,
  onChange,
  setRef,
  hasError,
}: ControlProps) {
  const v = typeof value === 'string' ? value : '';
  const validation = asTextValidation(question.validation);
  return (
    <textarea
      ref={setRef}
      value={v}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      minLength={validation?.minLength}
      maxLength={validation?.maxLength}
      aria-describedby={describedBy}
      aria-label={question.label}
      aria-required={question.required || undefined}
      aria-invalid={hasError || undefined}
      rows={3}
      className={controlClasses(hasError)}
    />
  );
}

function NumberControl({
  question,
  value,
  disabled,
  describedBy,
  onChange,
  setRef,
  hasError,
}: ControlProps) {
  const v = typeof value === 'number' && Number.isFinite(value) ? value : '';
  const validation = asNumberValidation(question.validation);
  return (
    <input
      ref={setRef}
      type="number"
      inputMode="decimal"
      value={v as number | ''}
      disabled={disabled}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === '') {
          onChange(undefined);
          return;
        }
        const n = Number(raw);
        onChange(Number.isFinite(n) ? n : undefined);
      }}
      min={validation?.min}
      max={validation?.max}
      step={validation?.step}
      aria-describedby={describedBy}
      aria-label={question.label}
      aria-required={question.required || undefined}
      aria-invalid={hasError || undefined}
      className={controlClasses(hasError)}
    />
  );
}

function ScaleControl({
  question,
  value,
  disabled,
  describedBy,
  onChange,
  setRef,
  hasError,
}: ControlProps) {
  const scale = asScaleValidation(question.validation);
  if (!scale) {
    return (
      <p className="text-xs text-error" role="alert">
        Scale question is missing required min/max bounds.
      </p>
    );
  }
  const v = typeof value === 'number' && Number.isFinite(value) ? value : scale.min;
  const valuetext = `${v} of ${scale.max}${
    scale.minLabel || scale.maxLabel
      ? `, ${scale.minLabel ?? scale.min} to ${scale.maxLabel ?? scale.max}`
      : ''
  }`;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-3">
        <span
          className="text-xs text-text-muted shrink-0"
          aria-label={`Minimum: ${scale.minLabel ?? String(scale.min)}`}
        >
          {scale.minLabel ?? scale.min}
        </span>
        <input
          ref={setRef}
          type="range"
          min={scale.min}
          max={scale.max}
          step={scale.step}
          value={v}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-describedby={describedBy}
          aria-label={question.label}
          aria-valuetext={valuetext}
          aria-required={question.required || undefined}
          aria-invalid={hasError || undefined}
          className={`flex-1 accent-accent focus-visible:ring-2 focus-visible:outline-none ${
            hasError ? 'focus-visible:ring-error/40' : 'focus-visible:ring-accent/40'
          }`}
        />
        <span
          className="text-xs text-text-muted shrink-0"
          aria-label={`Maximum: ${scale.maxLabel ?? String(scale.max)}`}
        >
          {scale.maxLabel ?? scale.max}
        </span>
      </div>
      <p className="text-xs text-text-secondary tabular-nums" aria-live="polite">
        Current value: {v}
      </p>
    </div>
  );
}

function OrderingControl({
  question,
  value,
  disabled,
  describedBy,
  onChange,
  setRef,
  hasError,
}: ControlProps) {
  const options = asOptions(question.options);
  const initial = options.map((o) => o.key);
  const order = Array.isArray(value) ? (value as string[]) : initial;
  const normalized = useMemo(() => {
    const known = new Set(options.map((o) => o.key));
    const seen = new Set<string>();
    const arr: string[] = [];
    for (const k of order) {
      if (known.has(k) && !seen.has(k)) {
        arr.push(k);
        seen.add(k);
      }
    }
    for (const k of initial) {
      if (!seen.has(k)) {
        arr.push(k);
        seen.add(k);
      }
    }
    return arr;
  }, [order, options, initial]);

  // Live announcement for reordering operations (VAL-MODEQ-144).
  // Announces the moved option and its new position so screen reader
  // users understand the result of each move without seeing the visual
  // reorder.
  const [moveAnnouncement, setMoveAnnouncement] = useState('');

  function move(index: number, dir: -1 | 1) {
    const next = [...normalized];
    const target = index + dir;
    if (target < 0 || target >= next.length) {
      return;
    }
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
    const label = labelByKey.get(next[target]) ?? next[target];
    setMoveAnnouncement(`${label} moved to position ${target + 1} of ${next.length}`);
  }

  const labelByKey = new Map(options.map((o) => [o.key, o.label]));
  return (
    <div>
      <ol
        className="space-y-1"
        aria-describedby={describedBy}
        aria-label={question.label}
        aria-required={question.required || undefined}
        aria-invalid={hasError || undefined}
        tabIndex={-1}
        ref={setRef}
      >
        {normalized.map((key, i) => {
          const label = labelByKey.get(key) ?? key;
          return (
            <li
              key={key}
              className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1"
            >
              <span
                className="text-xs tabular-nums text-text-muted w-5 shrink-0"
                aria-hidden="true"
              >
                {i + 1}
              </span>
              <span className="text-sm text-text-primary break-words flex-1 min-w-0">{label}</span>
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={disabled || i === 0}
                aria-label={`Move ${label} up`}
                className={`inline-flex shrink-0 items-center justify-center rounded border border-white/[0.1] px-1.5 py-0.5 text-text-secondary hover:bg-white/[0.05] focus-visible:ring-2 focus-visible:outline-none disabled:opacity-40 disabled:cursor-not-allowed ${
                  hasError ? 'focus-visible:ring-error/40' : 'focus-visible:ring-accent/40'
                }`}
              >
                <ArrowUp className="h-3 w-3" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={disabled || i === normalized.length - 1}
                aria-label={`Move ${label} down`}
                className={`inline-flex shrink-0 items-center justify-center rounded border border-white/[0.1] px-1.5 py-0.5 text-text-secondary hover:bg-white/[0.05] focus-visible:ring-2 focus-visible:outline-none disabled:opacity-40 disabled:cursor-not-allowed ${
                  hasError ? 'focus-visible:ring-error/40' : 'focus-visible:ring-accent/40'
                }`}
              >
                <ArrowDown className="h-3 w-3" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ol>
      <span aria-live="polite" className="sr-only" data-testid="ordering-announcement">
        {moveAnnouncement}
      </span>
    </div>
  );
}
