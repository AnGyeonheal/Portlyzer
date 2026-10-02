import * as React from "react";
import { cn } from "./utils";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input className={cn("form-input", className)} {...props} />;
}

export function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return <select className={cn("form-input form-select", className)} {...props}>{children}</select>;
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea className={cn("form-input min-h-24 resize-y", className)} {...props} />;
}

export function Field({ label, hint, children, className, required, htmlFor }: {
  label: string; hint?: string; children: React.ReactNode; className?: string; required?: boolean; htmlFor?: string;
}) {
  const generatedId = React.useId();
  const child = React.isValidElement<{ id?: string; "aria-describedby"?: string }>(children) ? children : null;
  const id = htmlFor ?? child?.props.id ?? generatedId;
  const hintId = `${id}-hint`;
  const control = child && !htmlFor ? React.cloneElement(child, { id, "aria-describedby": hint ? [child.props["aria-describedby"], hintId].filter(Boolean).join(" ") : child.props["aria-describedby"] }) : children;
  return (
    <div className={cn("field", className)}>
      <div className="field-label"><label htmlFor={id}>{label}</label>{required && <span className="text-teal-700" aria-hidden="true"> *</span>}</div>
      {control}
      {hint && <span className="field-hint" id={hintId}>{hint}</span>}
    </div>
  );
}
