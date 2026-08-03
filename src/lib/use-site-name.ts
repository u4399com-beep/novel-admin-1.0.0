'use client';

import { useState, useEffect } from 'react';
import { apiFetch } from './api-fetch';

const DEFAULT_SITE_NAME = '小说阁';

/**
 * Fetch the admin-configured site name from /api/public/settings.
 * Falls back to DEFAULT_SITE_NAME if the API is unavailable.
 * Uses a shared module-level cache to avoid duplicate fetches.
 */
let cachedName: string | null = null;
let fetchPromise: Promise<string> | null = null;

export function useSiteName(): string {
  const [name, setName] = useState<string>(() => cachedName ?? DEFAULT_SITE_NAME);

  useEffect(() => {
    // Return cached value if already loaded (no setState needed - already in initial state)
    if (cachedName !== null) return;

    // Deduplicate concurrent fetches
    if (!fetchPromise) {
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
    }

    fetchPromise.then((n) => setName(n));
  }, []);

  return name;
}
