import type { ButtonHTMLAttributes, ReactNode } from "react";
import { AlertTriangle, CheckCircle2, LoaderCircle, RefreshCw, Search, X } from "lucide-react";
import { classNames } from "./lib";

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "success" | "warning" | "danger" | "accent" }) {
  return <span className={classNames("badge", `badge-${tone}`)}>{children}</span>;
}

export function Button({ className, variant = "secondary", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  return <button className={classNames("button", `button-${variant}`, className)} {...props} />;
}

export function Toggle({ checked, onChange, disabled = false, label }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <label className={classNames("toggle", disabled && "is-disabled")}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span aria-hidden="true"><i /></span>
    </label>
  );
}

export function SearchField({ value, onChange, placeholder = "Search" }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label className="search-field">
      <Search aria-hidden size={14} strokeWidth={1.7} />
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      {value ? (
        <button type="button" aria-label="Clear search" onClick={() => onChange("")}>
          <X aria-hidden size={13} strokeWidth={1.7} />
        </button>
      ) : null}
    </label>
  );
}

export function PageHeader({ eyebrow, title, description, onRefresh, refreshing, actions }: { eyebrow: string; title: string; description: string; onRefresh?: () => void; refreshing?: boolean; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <p className="page-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      <div className="page-actions">
        {actions}
        {onRefresh ? (
          <Button variant="ghost" aria-label={`Refresh ${title}`} onClick={onRefresh} disabled={refreshing}>
            <RefreshCw aria-hidden size={14} strokeWidth={1.7} className={refreshing ? "spin" : ""} />
            Refresh
          </Button>
        ) : null}
      </div>
    </header>
  );
}

export function StatStrip({ items }: { items: Array<{ label: string; value: ReactNode; detail?: string }> }) {
  return (
    <dl className="stat-strip">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
          {item.detail ? <small>{item.detail}</small> : null}
        </div>
      ))}
    </dl>
  );
}

export function SectionHeading({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-icon">{icon}</div> : null}
      <strong>{title}</strong>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function LoadingState({ label = "Loading router data" }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <LoaderCircle aria-hidden size={18} strokeWidth={1.7} className="spin" />
      <span>{label}</span>
    </div>
  );
}

export function InlineNotice({ tone = "neutral", title, children }: { tone?: "neutral" | "success" | "warning" | "danger"; title: string; children?: ReactNode }) {
  const Icon = tone === "success" ? CheckCircle2 : AlertTriangle;
  return (
    <div className={classNames("inline-notice", `notice-${tone}`)}>
      <Icon aria-hidden size={16} strokeWidth={1.7} />
      <div><strong>{title}</strong>{children ? <p>{children}</p> : null}</div>
    </div>
  );
}

export function Dialog({ open, title, description, children, onClose }: { open: boolean; title: string; description?: string; children: ReactNode; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog-panel" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <header>
          <div>
            <h2 id="dialog-title">{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <button className="icon-button" type="button" aria-label="Close dialog" onClick={onClose}>
            <X aria-hidden size={16} strokeWidth={1.7} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
