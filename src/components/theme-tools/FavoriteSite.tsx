'use client'

/**
 * 收藏本站：
 * - 浏览器安全模型不允许 JS 直接写入收藏夹，规范做法是「快捷键引导」：
 *   1) 点击按钮 → toast 提示按 ⌘/Ctrl + D（或地址栏 ☆ 图标）完成收藏；
 *   2) 全局监听 Ctrl/Cmd + D → 同时弹出含站名的引导气泡，与浏览器原生收藏框配合。
 *   注：刻意不 preventDefault —— 拦截后原生收藏框不再弹出，反而让收藏不可用；
 *   我们的气泡只做补充引导，保证功能真实可用。
 * - useFavoriteSite()：供各主题自定义按钮调用的 hook（全局快捷键监听模块级单例）。
 * - showSetHomepageHint()：「设为首页」的诚实降级提示（现代浏览器已禁止 JS 改主页）。
 */
import { useEffect } from 'react'
import { toast } from 'sonner'
import { useSettings } from '@/hooks/use-novel-data'
import { favoriteShortcutLabel, tryLegacyBookmark } from '@/lib/site-tools'

let listenerInstalled = false
let currentSiteName = '本站'

function ensureGlobalListener(): void {
  if (listenerInstalled || typeof window === 'undefined') return
  listenerInstalled = true
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.altKey || e.shiftKey) return
    const isD = e.key.toLowerCase() === 'd'
    if (!(e.ctrlKey || e.metaKey) || !isD) return
    toast(`按下 ${favoriteShortcutLabel()} 收藏「${currentSiteName}」`, {
      description: '在浏览器弹出的收藏确认框中点击「完成」即可收藏本站',
      duration: 3500,
    })
  })
}

export function useFavoriteSite() {
  const { data: settings } = useSettings()
  const siteName = settings?.siteName ?? '本站'

  useEffect(() => {
    currentSiteName = siteName
    ensureGlobalListener()
  }, [siteName])

  return {
    shortcut: favoriteShortcutLabel(),
    promptFavorite: () => {
      if (tryLegacyBookmark()) {
        toast.success(`已发起收藏「${siteName}」`)
        return
      }
      toast(`收藏「${siteName}」`, {
        description: `请按 ${favoriteShortcutLabel()}，或点击浏览器地址栏右侧的 ☆ 图标完成收藏`,
        duration: 4000,
      })
    },
  }
}

/** 「设为首页」提示：现代浏览器禁止 JS 修改主页，给出手动设置指引 */
export function showSetHomepageHint(siteName: string): void {
  toast('设为首页', {
    description: `出于浏览器安全限制，无法自动把「${siteName}」设为主页；请在浏览器设置的「外观 / 主页」中手动填入本站地址`,
    duration: 4500,
  })
}

export interface FavoriteSiteButtonProps {
  label?: string
  className?: string
  title?: string
}

/** 中性样式的收藏按钮（主题可完全用 className 覆盖配色） */
export function FavoriteSiteButton({ label = '收藏本站', className, title }: FavoriteSiteButtonProps) {
  const { promptFavorite, shortcut } = useFavoriteSite()
  return (
    <button
      type="button"
      title={title ?? `按 ${shortcut} 也可收藏`}
      onClick={promptFavorite}
      className={className}
    >
      {label}
    </button>
  )
}
