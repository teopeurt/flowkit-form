import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'error';

export function Button({
  children,
  busy = false,
  variant = 'secondary',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  variant?: 'primary' | 'secondary' | 'danger' | 'quiet';
}) {
  return (
    <button {...props} className={`fk-button fk-button--${variant} ${props.className ?? ''}`} disabled={busy || props.disabled} aria-busy={busy || undefined}>
      {busy ? 'Working…' : children}
    </button>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`fk-badge fk-badge--${tone}`}>{children}</span>;
}

export function Panel({ children, title, meta }: { children: ReactNode; title: string; meta?: ReactNode }) {
  return (
    <section className="fk-panel" aria-labelledby={`panel-${slug(title)}`}>
      <header className="fk-panel__header">
        <h2 id={`panel-${slug(title)}`}>{title}</h2>
        {meta}
      </header>
      <div className="fk-panel__body">{children}</div>
    </section>
  );
}

export function Alert({ children, title, tone = 'warning' }: { children: ReactNode; title: string; tone?: 'warning' | 'error' | 'success' }) {
  return (
    <div className={`fk-alert fk-alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <strong>{title}</strong>
      <div>{children}</div>
    </div>
  );
}

export function EmptyState({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div className="fk-empty">
      <span className="fk-empty__mark" aria-hidden="true">↳</span>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return <div className="fk-loading" role="status"><span aria-hidden="true" />{label}</div>;
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string };

export function TextField({ label, hint, id, ...props }: FieldProps) {
  const fieldId = id ?? `field-${props.name ?? slug(label)}`;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  return (
    <label className="fk-field" htmlFor={fieldId}>
      <span>{label}</span>
      <input {...props} id={fieldId} aria-describedby={hintId} />
      {hint ? <small id={hintId}>{hint}</small> : null}
    </label>
  );
}

export function TextareaField({ label, hint, id, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string }) {
  const fieldId = id ?? `field-${props.name ?? slug(label)}`;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  return (
    <label className="fk-field" htmlFor={fieldId}>
      <span>{label}</span>
      <textarea {...props} id={fieldId} aria-describedby={hintId} />
      {hint ? <small id={hintId}>{hint}</small> : null}
    </label>
  );
}

export function SelectField({
  label,
  options,
  id,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; options: readonly { label: string; value: string }[] }) {
  const fieldId = id ?? `field-${props.name ?? slug(label)}`;
  return (
    <label className="fk-field" htmlFor={fieldId}>
      <span>{label}</span>
      <select {...props} id={fieldId}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

export function DataTable({ children, label }: { children: ReactNode; label: string }) {
  return <div className="fk-table-wrap"><table className="fk-table" aria-label={label}>{children}</table></div>;
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
