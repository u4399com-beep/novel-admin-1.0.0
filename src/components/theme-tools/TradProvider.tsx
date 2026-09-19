'use client'

/**
 * 简繁切换全局 Provider：
 * - 状态三态：origin（原文）/ trad（繁体）/ simp（简体），localStorage 持久化（novel-admin:s2t）
 * - 水合安全：通过 useSyncExternalStore 订阅持久化状态 —— 水合期使用服务端快照（origin），
 *   挂载后自动切换到客户端快照（localStorage 值），不产生水合差异，也无需在 effect 中 setState
 * - 引擎细节见 ./trad-engine.ts
 */
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { applyTradMode, type TradMode } from './trad-engine'

const STORAGE_KEY = 'novel-admin:s2t'

let cachedMode: TradMode | null = null
const listeners = new Set<() => void>()

function readStoredMode(): TradMode {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    if (v === 'trad' || v === 'simp' || v === 'origin') return v
  } catch {
    /* 忽略隐私模式读取失败 */
  }
  return 'origin'
}

function getSnapshot(): TradMode {
  if (cachedMode === null) cachedMode = readStoredMode()
  return cachedMode
}

/** 水合期快照：恒为 origin，保证与服务端渲染一致 */
function getServerSnapshot(): TradMode {
  return 'origin'
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function setGlobalMode(m: TradMode): void {
  cachedMode = m
  try {
    window.localStorage.setItem(STORAGE_KEY, m)
  } catch {
    /* 忽略持久化失败 */
  }
  listeners.forEach((l) => l())
}

interface TradContextValue {
  mode: TradMode
  setMode: (m: TradMode) => void
}

const TradContext = createContext<TradContextValue | null>(null)

export function TradProvider({ children }: { children: ReactNode }) {
  const mode = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  // 挂载（含持久化恢复后）与模式变化时应用 DOM 翻译引擎
  useEffect(() => {
    void applyTradMode(mode)
  }, [mode])

  const value = useMemo<TradContextValue>(() => ({ mode, setMode: setGlobalMode }), [mode])

  return <TradContext.Provider value={value}>{children}</TradContext.Provider>
}

/** 读取简繁切换状态（必须在 TradProvider 内使用） */
export function useTrad(): TradContextValue {
  const ctx = useContext(TradContext)
  if (!ctx) throw new Error('useTrad 必须在 <TradProvider> 内使用')
  return ctx
}
