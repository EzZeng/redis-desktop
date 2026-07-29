import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
  {
    variants: {
      variant: {
        string: "bg-type-string/15 text-type-string",
        hash: "bg-type-hash/15 text-type-hash",
        list: "bg-type-list/15 text-type-list",
        set: "bg-type-set/15 text-type-set",
        zset: "bg-type-zset/15 text-type-zset",
        muted: "bg-surface-3 text-muted",
      },
    },
    defaultVariants: { variant: "muted" },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
