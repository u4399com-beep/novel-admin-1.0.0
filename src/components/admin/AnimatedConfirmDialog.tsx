'use client';

import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface AnimatedConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'destructive' | 'warning' | 'default';
  loading?: boolean;
  onConfirm: () => void;
  icon?: ReactNode;
}

export function AnimatedConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText = '确认',
  cancelText = '取消',
  variant = 'destructive',
  loading = false,
  onConfirm,
  icon,
}: AnimatedConfirmDialogProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      queueMicrotask(() => setVisible(true));
    }
  }, [open]);

  const handleClose = useCallback(() => {
    if (loading) return;
    setVisible(false);
    setTimeout(() => onOpenChange(false), 200);
  }, [loading, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [open, handleClose]);

  const variantStyles = {
    destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
    warning: 'bg-amber-500 text-white hover:bg-amber-600',
    default: 'bg-primary text-primary-foreground hover:bg-primary/90',
  };

  const iconDefault = variant === 'destructive'
    ? <AlertTriangle className="h-5 w-5 text-destructive" />
    : variant === 'warning'
    ? <AlertTriangle className="h-5 w-5 text-amber-500" />
    : null;

  return (
    <AnimatePresence>
      {visible && (
        <>
          {/* Overlay */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
            onClick={handleClose}
          />
          {/* Dialog */}
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 10 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
          >
            <div
              className="glass-heavy rounded-xl shadow-2xl max-w-md w-full p-6 space-y-4"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-start gap-3">
                <div className="shrink-0 mt-0.5">
                  {icon ?? iconDefault}
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold">{title}</h3>
                  <p className="text-sm text-muted-foreground mt-1">{description}</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 -mt-1 -mr-1"
                  onClick={handleClose}
                  disabled={loading}
                  aria-label="关闭"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              {/* Actions */}
              <div className="flex items-center justify-end gap-2 pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleClose}
                  disabled={loading}
                >
                  {cancelText}
                </Button>
                <Button
                  size="sm"
                  className={variantStyles[variant]}
                  onClick={onConfirm}
                  disabled={loading}
                >
                  {loading ? (
                    <span className="flex items-center gap-1.5">
                      <span className="h-3.5 w-3.5 border-2 border-current border-t-transparent rounded-full export-spinner" />
                      处理中...
                    </span>
                  ) : confirmText}
                </Button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
