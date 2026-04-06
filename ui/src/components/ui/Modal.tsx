import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { clsx } from "clsx";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}

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
    <dialog
      ref={dialogRef}
      className={clsx(
        "m-auto max-h-[85vh] w-full max-w-lg rounded-2xl glass-raised neon-border p-0 text-text-primary shadow-2xl shadow-black/70 backdrop:bg-black/70 backdrop:backdrop-blur-md open:animate-fade-in",
        className,
      )}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
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
    </dialog>
  );
}
