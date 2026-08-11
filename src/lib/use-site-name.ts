'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './api-fetch';

const DEFAULT_SITE_NAME = '小说阁';

/**
 * Fetch the admin-configured site name from /api/public/settings.
 * Falls back to DEFAULT_SITE_NAME if the API is unavailable.
 * Uses a shared module-level cache to avoid duplicate fetches.
 * Supports explicit invalidation when admin changes the site name.
 */
let cachedName: string | null = null;
let fetchPromise: Promise<string> | null = null;

/** Invalidate the cached site name so next render re-fetches */
export function invalidateSiteNameCache(): void {
  cachedName = null;
  fetchPromise = null;
}

export function useSiteName(): string {
  const [name, setName] = useState<string>(() => cachedName ?? DEFAULT_SITE_NAME);

  const fetchName = useCallback(() => {
    if (fetchPromise) return fetchPromise;

    fetchPromise = apiFetch<{ siteName?: string }>('/api/public/settings', {
      silent: true,
      timeout: 5000,
    })
      .then((data) => {
        const n = data?.siteName?.trim();
        cachedName = n && n.length > 0 ? n : DEFAULT_SITE_NAME;
        return cachedName;
      })
      .catch(() => DEFAULT_SITE_NAME)
      .finally(() => { fetchPromise = null; });

    return fetchPromise;
  }, []);

  useEffect(() => {
    // Return cached value if already loaded
    if (cachedName !== null) return;

    fetchName().then((n) => setName(n));
  }, [fetchName]);

  // Listen for storage events from other tabs (admin changed site name)
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === 'site-name-invalidated') {
        invalidateSiteNameCache();
        fetchName().then((n) => setName(n));
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [fetchName]);

  return name;
}
