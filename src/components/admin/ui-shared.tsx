'use client'

/**
 * 管理后台共享 UI 原子件（自 panels.tsx / ScrapeCenter.tsx 提取的重复模式）：
 * - api：JSON fetch 封装（panels 与 scrape 组件族同一实现，此处为唯一权威版本）
 * - errMsg：unknown → 错误文案（toast.error 统一入口）
 * - runBusy：busy 状态守卫 + try/catch/finally + 错误 toast 的异步动作包装
 * - useDialogEscape：手写模态框 Esc 关闭（嵌套对话框内层用 capture=true）
 * - Field：表单字段行（label + 控件）
 * - Modal：遮罩 + role="dialog" 面板（点击遮罩关闭、面板阻止冒泡）
 * - DialogActions：右对齐 取消/保存 按钮组
 *
 * 注意：仅收敛结构与类名完全一致（或经参数逐字还原）的重复代码，渲染产物不变。
 */

import { useEffect, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

/* ==================== 请求与错误工具 ==================== */

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `请求失败(${res.status})`)
  return data as T
}

/** catch 分支统一文案：Error 取 message，其余用兜底文案 */
export function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback
}

/**
 * 异步动作统一包装：进入 busy → 执行 → 成功提示由 fn 自行触发 →
 * 失败 toast（Error.message 优先）→ 无论成败退出 busy。
 * T 兼容 boolean 守卫（setSaving）与 id 守卫（setBusyId: number | null）。
 */
export async function runBusy<T>(
  setBusy: (v: T) => void,
  busy: T,
  idle: T,
  fallback: string,
  fn: () => Promise<void>,
): Promise<void> {
  setBusy(busy)
  try {
    await fn()
  } catch (e) {
    toast.error(errMsg(e, fallback))
  } finally {
    setBusy(idle)
  }
}

/* ==================== 手写模态框 ==================== */

/**
 * 手写模态框的 Esc 关闭。嵌套对话框（章节编辑在章节管理内）的内层用 capture=true：
 * capture 监听先于 bubble 触发并 stopPropagation，保证 Esc 只关最上层。
 */
export function useDialogEscape(onClose: () => void, active = true, capture = false) {
  useEffect(() => {
    if (!active) return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', handler, capture)
    return () => document.removeEventListener('keydown', handler, capture)
  }, [onClose, active, capture])
}

/** 遮罩 + 对话框面板：点击遮罩关闭、面板阻止冒泡。top=true 用于嵌套顶层（z-70/黑 50%） */
export function Modal({
  label,
  onClose,
  panel,
  top = false,
  below,
  children,
}: {
  label: string
  onClose: () => void
  /** 面板容器类名（宽度/高度/内边距等，各对话框保持原值） */
  panel: string
  top?: boolean
  /** 渲染在面板之后、遮罩之内的兄弟节点（如嵌套的顶层编辑对话框，保持原 DOM 层级） */
  below?: ReactNode
  children: ReactNode
}) {
  return (
    <div
      className={top ? 'fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4' : 'fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4'}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={panel}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
      {below}
    </div>
  )
}

/** 对话框底部右对齐按钮组：取消（outline）+ 保存（busy 时禁用并显示「保存中…」） */
export function DialogActions({
  className,
  busy,
  onCancel,
  onSave,
  saveLabel = '保存',
}: {
  className: string
  busy: boolean
  onCancel: () => void
  onSave: () => void
  saveLabel?: string
}) {
  return (
    <div className={className}>
      <Button variant="outline" disabled={busy} onClick={onCancel}>取消</Button>
      <Button onClick={onSave} disabled={busy}>{busy ? '保存中…' : saveLabel}</Button>
    </div>
  )
}

/* ==================== 表单行 ==================== */

/** 表单字段行：左上角小标签 + 控件 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-neutral-600">{label}</span>
      {children}
    </label>
  )
}
