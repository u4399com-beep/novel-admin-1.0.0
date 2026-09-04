'use client';

import { useState, useCallback } from 'react';

export function useDeleteConfirm<T>() {
  const [deleteTarget, setDeleteTarget] = useState<T | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = useCallback(async (deleteFn: () => Promise<void>) => {
    setDeleting(true);
    setError(null);
    try {
      await deleteFn();
      setDeleteTarget(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '删除失败';
      setError(msg);
    } finally {
      setDeleting(false);
    }
  }, []);

  const cancelDelete = useCallback(() => { setDeleteTarget(null); setError(null); }, []);

  return {
    deleteTarget,
    setDeleteTarget,
    deleting,
    error,
    handleDelete,
    cancelDelete,
    isOpen: deleteTarget !== null,
  };
}
