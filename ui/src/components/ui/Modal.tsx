import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { clsx } from "clsx";
import { motion, AnimatePresence } from "framer-motion";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}

const backdropVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
};

const panelVariants = {
  hidden: { opacity: 0, scale: 0.95 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: {
      type: "spring" as const,
      damping: 25,
      stiffness: 400,
      duration: 0.2,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    transition: { duration: 0.15, ease: "easeIn" as const },
  },
};

export function Modal({ open, onClose, title, children, className }: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => onClose();
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [onClose]);

  return (
    <AnimatePresence>
      {open && (
        <dialog
          ref={dialogRef}
          className={clsx(
            "m-auto max-h-[85vh] w-full max-w-lg rounded-2xl bg-transparent p-0 text-text-primary backdrop:bg-transparent open:flex open:items-center open:justify-center",
            className,
          )}
          onClick={(e) => {
            if (e.target === dialogRef.current) onClose();
          }}
        >
          {/* Animated backdrop */}
          <motion.div
            className="fixed inset-0 bg-black/70 backdrop-blur-md"
            variants={backdropVariants}
            initial="hidden"
            animate="visible"
            exit="hidden"
            transition={{ duration: 0.15 }}
            onClick={onClose}
          />

          {/* Animated content panel */}
          <motion.div
            className="relative glass-raised neon-border rounded-2xl shadow-2xl shadow-black/70 w-full max-w-lg"
            variants={panelVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-4">
              <h2 className="text-base font-semibold font-display">{title}</h2>
              <button
                onClick={onClose}
                className="rounded-lg p-1.5 text-text-secondary hover:text-neon-cyan hover:bg-white/[0.05] transition-all duration-300 cursor-pointer"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-6">{children}</div>
          </motion.div>
        </dialog>
      )}
    </AnimatePresence>
  );
}
