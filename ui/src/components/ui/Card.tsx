import { clsx } from "clsx";
import { motion } from "framer-motion";
import type { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  hoverable?: boolean;
  padding?: boolean;
  animated?: boolean;
  className?: string;
  onClick?: () => void;
}

export function Card({
  children,
  header,
  footer,
  hoverable = false,
  padding = true,
  animated = true,
  className,
  onClick,
}: CardProps) {
  const classes = clsx(
    "rounded-xl glass transition-all duration-300",
    hoverable && "glass-hover cursor-pointer",
    className,
  );

  const content = (
    <>
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
    </>
  );

  if (animated) {
    return (
      <motion.div
        className={classes}
        onClick={onClick}
        whileHover={{ scale: 1.01, borderColor: "rgba(255, 255, 255, 0.1)" }}
        whileTap={{ scale: 0.995 }}
        transition={{ duration: 0.15, ease: "easeOut" as const }}
      >
        {content}
      </motion.div>
    );
  }

  return (
    <div className={classes} onClick={onClick}>
      {content}
    </div>
  );
}
