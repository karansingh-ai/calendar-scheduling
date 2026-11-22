import { useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "danger" | "ghost";
const variants: Record<Variant, string> = {
  primary: "bg-brand text-white hover:opacity-90 shadow-sm",
  secondary: "bg-white text-gray-800 border border-gray-300 hover:bg-gray-50 shadow-sm",
  danger: "bg-white text-red-700 border border-red-200 hover:bg-red-50",
  ghost: "text-gray-700 hover:bg-gray-100",
};

export function Button({ variant = "primary", className, loading, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        variants[variant],
        className,
      )}
    >
      {loading && <Spinner small />}
      {children}
    </button>
  );
}

export const inputClass =
  "block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm placeholder:text-gray-400 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand disabled:bg-gray-100";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputClass, props.className)} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={3} {...props} className={cx(inputClass, props.className)} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(inputClass, "pr-8", props.className)} />;
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1 block text-sm font-medium text-gray-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-500">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx("inline-flex cursor-pointer select-none items-center gap-2 text-sm", disabled && "opacity-50")}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx("relative h-5 w-9 rounded-full transition", checked ? "bg-brand" : "bg-gray-300")}
      >
        <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition", checked ? "left-[18px]" : "left-0.5")} />
      </button>
      {label}
    </label>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-lg border border-gray-200 bg-white shadow-sm", className)}>{children}</div>;
}

export function Section({ title, description, children, actions }: { title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-gray-500">{description}</p>}
        </div>
        {actions}
      </div>
      <div className="space-y-4">{children}</div>
    </Card>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-gray-500">{description}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

export function Badge({ children, tone = "gray" }: { children: ReactNode; tone?: "gray" | "green" | "red" | "blue" | "amber" }) {
  const tones = {
    gray: "bg-gray-100 text-gray-700",
    green: "bg-green-50 text-green-700 ring-green-600/20",
    red: "bg-red-50 text-red-700 ring-red-600/20",
    blue: "bg-blue-50 text-blue-700 ring-blue-600/20",
    amber: "bg-amber-50 text-amber-800 ring-amber-600/20",
  };
  return <span className={cx("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ring-gray-500/10", tones[tone])}>{children}</span>;
}

export function Spinner({ small }: { small?: boolean }) {
  return <span className={cx("inline-block animate-spin rounded-full border-2 border-current border-t-transparent", small ? "h-3.5 w-3.5" : "h-6 w-6 text-gray-400")} aria-label="Loading" />;
}

export function Loading() {
  return (
    <div className="flex justify-center py-16">
      <Spinner />
    </div>
  );
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{typeof error === "string" ? error : (error as Error).message}</div>;
}

export function Notice({ children, tone = "blue" }: { children: ReactNode; tone?: "blue" | "green" | "amber" }) {
  const tones = { blue: "border-blue-200 bg-blue-50 text-blue-900", green: "border-green-200 bg-green-50 text-green-900", amber: "border-amber-200 bg-amber-50 text-amber-900" };
  return <div className={cx("rounded-md border px-3 py-2 text-sm", tones[tone])}>{children}</div>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 px-6 py-12 text-center">
      <p className="font-medium text-gray-800">{title}</p>
      {children && <div className="mt-1 text-sm text-gray-500">{children}</div>}
    </div>
  );
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-lg font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

export function SecretReveal({ label, secret, onDone }: { label: string; secret: string; onDone: () => void }) {
  return (
    <Notice tone="amber">
      <p className="mb-2 font-medium">{label}</p>
      <div className="flex gap-2">
        <code className="flex-1 overflow-x-auto rounded bg-white px-2 py-1.5 font-mono text-xs ring-1 ring-amber-200">{secret}</code>
        <CopyButton text={secret} />
        <Button variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
    </Notice>
  );
}
