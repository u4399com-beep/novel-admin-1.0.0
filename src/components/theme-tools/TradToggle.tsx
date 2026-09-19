'use client'

/**
 * 简繁切换按钮（中性样式，className 由主题注入配色）。
 * 按钮文案显示「目标语言」：简体页面显示「繁體版」，繁体模式显示「简体版」。
 * native='t' 用于原生繁体文案的主题（如 101kks）：开启时切换为简体，再点恢复原文（繁体）。
 */
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useTrad } from './TradProvider'
import type { TradMode } from './trad-engine'

export interface TradToggleProps {
  /** 主题原生文案语言：'s' 简体（默认）| 't' 繁体 */
  native?: 's' | 't'
  className?: string
  /** 是否在切换后弹 toast 提示（默认开启） */
  silent?: boolean
}

function nextMode(native: 's' | 't', mode: TradMode): { next: TradMode; label: string; hint: string } {
  if (native === 't') {
    if (mode === 'simp') {
      return { next: 'origin', label: '繁體版', hint: '已恢復原文（繁體）' }
    }
    return { next: 'simp', label: '簡體版', hint: '已切換為簡體' }
  }
  if (mode === 'trad') {
    return { next: 'origin', label: '简体版', hint: '已恢复原文（简体）' }
  }
  return { next: 'trad', label: '繁體版', hint: '已切换为繁體' }
}

export function TradToggle({ native = 's', className, silent = false }: TradToggleProps) {
  const { mode, setMode } = useTrad()
  const action = nextMode(native, mode)

  return (
    <button
      type="button"
      onClick={() => {
        setMode(action.next)
        if (!silent) toast.success(action.hint)
      }}
      className={cn('cursor-pointer transition-colors', className)}
    >
      {action.label}
    </button>
  )
}
