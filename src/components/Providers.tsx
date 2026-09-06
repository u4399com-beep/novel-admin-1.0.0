'use client';

import { SessionProvider } from 'next-auth/react';
import { ThemeProvider, useTheme } from 'next-themes';
import type { ReactNode } from 'react';
import { useEffect, useCallback, useRef, useState } from 'react';

// ─── Scheduled Dark Mode Hook ─────────────────────────────────
// Auto-switches to dark mode based on time of day (e.g., after 9pm).
// Users can override manually; the schedule won't fight back until
// the next transition boundary.
const DARK_START_HOUR = 21; // 9pm
const DARK_END_HOUR = 6;    // 6am

function useScheduledDarkMode() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const lastAutoSwitch = useRef<number>(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    // Defer to avoid React Compiler set-state-in-effect lint
    queueMicrotask(() => setMounted(true));
  }, []);

  const checkSchedule = useCallback(() => {
    if (!mountedRef.current) return;
    // Only auto-switch if user is on "system" or hasn't manually overridden recently
    // (within 5 minutes of a schedule boundary, don't override manual changes)
    const now = new Date();
    const hour = now.getHours();
    const isDarkHours = hour >= DARK_START_HOUR || hour < DARK_END_HOUR;

    // Check if we should auto-switch
    const preferDark = isDarkHours;
    const currentIsDark = resolvedTheme === 'dark';

    if (preferDark !== currentIsDark) {
      const minutesSinceLastSwitch = (Date.now() - lastAutoSwitch.current) / 60000;
      if (minutesSinceLastSwitch > 5) {
        // Only auto-switch if user hasn't manually toggled in the last 5 minutes
        const scheduledPref = localStorage.getItem('theme-scheduled-pref');
        if (scheduledPref !== 'manual') {
          setTheme(preferDark ? 'dark' : 'light');
          lastAutoSwitch.current = Date.now();
        }
      }
    }
  }, [mounted, resolvedTheme, setTheme]);

  // Check on mount and every 5 minutes
  useEffect(() => {
    if (!mounted) return;
    checkSchedule();
    const interval = setInterval(checkSchedule, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [mounted, checkSchedule]);

  // Listen for manual theme changes and mark as manual override
  useEffect(() => {
    if (!mounted) return;
    const handleStorage = () => {
      const current = localStorage.getItem('theme');
      if (current && current !== 'system') {
        localStorage.setItem('theme-scheduled-pref', 'manual');
        // Clear manual flag after 30 minutes so schedule can resume
        setTimeout(() => {
          localStorage.removeItem('theme-scheduled-pref');
        }, 30 * 60 * 1000);
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [mounted]);
}

// ─── Smooth Theme Transition Wrapper ──────────────────────────
function ThemeTransitionWrapper({ children }: { children: ReactNode }) {
  useScheduledDarkMode();

  // Add transition class on theme change for smooth color transitions
  const { resolvedTheme } = useTheme();
  const prevTheme = useRef(resolvedTheme);

  useEffect(() => {
    if (prevTheme.current !== resolvedTheme && resolvedTheme) {
      document.documentElement.classList.add('theme-transition');
      const timer = setTimeout(() => {
        document.documentElement.classList.remove('theme-transition');
      }, 400);
      prevTheme.current = resolvedTheme;
      return () => clearTimeout(timer);
    }
    prevTheme.current = resolvedTheme;
  }, [resolvedTheme]);

  return <>{children}</>;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange={false}
      >
        <ThemeTransitionWrapper>
          {children}
        </ThemeTransitionWrapper>
      </ThemeProvider>
    </SessionProvider>
  );
}