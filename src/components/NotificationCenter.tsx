'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Bell, X, BookOpen, CheckCircle2, AlertTriangle, Info, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';

// ─── Notification Types ──────────────────────────────────────

export type NotificationType = 'new_chapter' | 'scrape_complete' | 'system_alert' | 'info';

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  timestamp: number;
  read: boolean;
}

// ─── Icons per type ──────────────────────────────────────────

const TYPE_CONFIG: Record<NotificationType, { icon: typeof Bell; color: string; label: string }> = {
  new_chapter: { icon: BookOpen, color: 'text-emerald-500', label: '新章节' },
  scrape_complete: { icon: CheckCircle2, color: 'text-blue-500', label: '采集完成' },
  system_alert: { icon: AlertTriangle, color: 'text-amber-500', label: '系统提醒' },
  info: { icon: Info, color: 'text-muted-foreground', label: '通知' },
};

// ─── Storage helpers ─────────────────────────────────────────

const NOTIFICATIONS_KEY = 'app-notifications';
const MAX_NOTIFICATIONS = 50;

function loadNotifications(): Notification[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(NOTIFICATIONS_KEY) || '[]');
  } catch { return []; }
}

function saveNotifications(notifs: Notification[]) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(notifs.slice(0, MAX_NOTIFICATIONS)));
}

// ─── Public API for pushing notifications ────────────────────

export function pushNotification(notif: Omit<Notification, 'id' | 'timestamp' | 'read'>) {
  const notifs = loadNotifications();
  const newNotif: Notification = {
    ...notif,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    read: false,
  };
  notifs.unshift(newNotif);
  saveNotifications(notifs);
  // Dispatch custom event for re-render
  window.dispatchEvent(new CustomEvent('notifications-updated'));
}

// ─── Format relative time ────────────────────────────────────

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}天前`;
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

// ─── Component ───────────────────────────────────────────────

export function NotificationCenter() {
  // Load on mount
  const [notifications, setNotifications] = useState<Notification[]>(() => loadNotifications());
  const [open, setOpen] = useState(false);
  const [bellAnimating, setBellAnimating] = useState(false);
  const bellRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const handler = () => {
      setNotifications(loadNotifications());
      setBellAnimating(true);
      setTimeout(() => setBellAnimating(false), 700);
    };
    window.addEventListener('notifications-updated', handler);
    return () => window.removeEventListener('notifications-updated', handler);
  }, []);

  const unreadCount = notifications.filter((n) => !n.read).length;

  const markAsRead = useCallback((id: string) => {
    setNotifications((prev) => {
      const next = prev.map((n) => n.id === id ? { ...n, read: true } : n);
      saveNotifications(next);
      return next;
    });
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => {
      const next = prev.map((n) => ({ ...n, read: true }));
      saveNotifications(next);
      return next;
    });
  }, []);

  const removeNotification = useCallback((id: string) => {
    setNotifications((prev) => {
      const next = prev.filter((n) => n.id !== id);
      saveNotifications(next);
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    setNotifications([]);
    saveNotifications([]);
  }, []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          ref={bellRef}
          variant="ghost"
          size="icon"
          className="relative h-8 w-8"
          aria-label={`通知${unreadCount > 0 ? ` (${unreadCount}条未读)` : ''}`}
        >
          <Bell className={`h-4 w-4 ${bellAnimating ? 'notification-bell-ring' : ''}`} />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 h-4 min-w-4 flex items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white leading-none px-1 badge-pop">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end" sideOffset={8}>
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <span className="text-sm font-medium">通知</span>
          <div className="flex items-center gap-1">
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                className="text-[11px] text-primary hover:underline"
              >
                全部已读
              </button>
            )}
            {notifications.length > 0 && (
              <button
                onClick={clearAll}
                className="text-[11px] text-muted-foreground hover:text-foreground ml-2"
              >
                清空
              </button>
            )}
          </div>
        </div>

        {/* Notification list */}
        {notifications.length === 0 ? (
          <div className="py-12 text-center">
            <Bell className="mx-auto h-8 w-8 text-muted-foreground/20" />
            <p className="mt-2 text-xs text-muted-foreground">暂无通知</p>
          </div>
        ) : (
          <ScrollArea className="max-h-80">
            <div className="divide-y">
              {notifications.map((notif) => {
                const config = TYPE_CONFIG[notif.type];
                const Icon = config.icon;
                return (
                  <div
                    key={notif.id}
                    className={`flex items-start gap-2.5 px-3 py-2.5 transition-colors ${!notif.read ? 'bg-primary/5' : ''}`}
                    onClick={() => markAsRead(notif.id)}
                  >
                    <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${config.color}`} />
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs leading-tight ${!notif.read ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
                        {notif.title}
                      </p>
                      <p className="text-[11px] text-muted-foreground/70 mt-0.5 line-clamp-2">
                        {notif.message}
                      </p>
                      <span className="text-[10px] text-muted-foreground/50 mt-0.5 block">
                        {formatRelativeTime(notif.timestamp)}
                      </span>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); removeNotification(notif.id); }}
                      className="shrink-0 h-5 w-5 flex items-center justify-center rounded text-muted-foreground/30 hover:text-foreground hover:bg-muted transition-colors opacity-0 group-hover:opacity-100"
                      aria-label="删除通知"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}
