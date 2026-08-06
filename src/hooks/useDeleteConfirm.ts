'use client';

import { useState, useCallback } from 'react';

export function useDeleteConfirm<T>() {
  const [deleteTarget, setDeleteTarget] = useState<T | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = useCallback(async (deleteFn: () => Promise<void>) => {
    setDeleting(true);
    try {
      await deleteFn();
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  }, []);

  const cancelDelete = useCallback(() => setDeleteTarget(null), []);

  return {
    deleteTarget,
    setDeleteTarget,
    deleting,
    handleDelete,
    cancelDelete,
    isOpen: deleteTarget !== null,
  };
}
