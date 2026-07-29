import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, ...props }, ref) => (
  <input
    type={type}
    ref={ref}
    className={cn(
      "flex h-8 w-full rounded-[var(--radius-sm)] border border-border bg-surface-2 px-2.5 text-[13px] text-fg placeholder:text-subtle",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 focus-visible:border-border-strong",
      "disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";
