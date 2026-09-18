/**
 * 站点通用小工具：平台检测 / 收藏本站辅助。
 * 纯函数库，仅在客户端组件中调用（涉及 navigator/window 的函数都做了 typeof 守卫）。
 */

/** 是否为苹果系平台（Mac / iPhone / iPad），用于展示 ⌘ 快捷键 */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const p = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`
  return /Mac|iPhone|iPad|iPod/i.test(p)
}

/** 收藏本站快捷键文案：Mac 显示 ⌘ + D，其余显示 Ctrl + D */
export function favoriteShortcutLabel(): string {
  return isApplePlatform() ? '⌘ + D' : 'Ctrl + D'
}

/**
 * 浏览器无法用标准 JS 强制收藏，这里保留两个历史遗留接口的尝试
 * （IE 的 window.external.AddFavorite / 旧 Firefox 的 window.sidebar.addPanel），
 * 现代浏览器均不存在这两个 API，会返回 false 走提示降级。
 */
export function tryLegacyBookmark(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const w = window as unknown as {
      external?: { AddFavorite?: (url: string, title: string) => void }
      sidebar?: { addPanel?: (title: string, url: string, customUrl: string) => void }
    }
    if (w.external && typeof w.external.AddFavorite === 'function') {
      w.external.AddFavorite(window.location.href, document.title)
      return true
    }
    if (w.sidebar && typeof w.sidebar.addPanel === 'function') {
      w.sidebar.addPanel(document.title, window.location.href, '')
      return true
    }
  } catch {
    /* 忽略旧接口异常 */
  }
  return false
}
