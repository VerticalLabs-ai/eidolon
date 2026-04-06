import { clsx } from "clsx";
import type { ReactNode, HTMLAttributes } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  hoverable?: boolean;
  padding?: boolean;
}

export function Card({
  children,
  header,
  footer,
  hoverable = false,
  padding = true,
  className,
  ...props
}: CardProps) {
  return (
    <div
      className={clsx(
        "rounded-xl glass transition-all duration-300",
        hoverable &&
          "glass-hover cursor-pointer",
        className,
      )}
      {...props}
    >
      {header && (
        <div className="border-b border-white/[0.06] px-5 py-3.5 text-sm font-medium text-text-primary font-display">
          <div className="bg-white/[0.04] absolute bottom-0 left-0 right-0 h-px" />
          {header}
        </div>
      )}
      {padding ? <div className="p-5">{children}</div> : children}
      {footer && (
        <div className="border-t border-white/[0.06] px-5 py-3 text-sm text-text-secondary">
          {footer}
        </div>
      )}
    </div>
  );
}
