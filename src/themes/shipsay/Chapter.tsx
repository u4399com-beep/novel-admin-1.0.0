'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Maximize2, Minimize2, Moon, Sun } from 'lucide-react'
import { useChapter } from '@/hooks/use-novel-data'
import { READER_LINE_HEIGHTS, readerFontStack, setReaderPrefs, stepFontSize, useReaderPrefs } from '@/hooks/use-reader-prefs'
import { cn } from '@/lib/utils'
import type { ViewProps } from '../types'
import { ErrorBox, fmtWords } from './parts'

function ToolBtn({
  children,
  onClick,
  title,
  active,
}: {
  children: ReactNode
  onClick: () => void
  title: string
  active?: boolean
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cn(
        'flex h-[26px] min-w-[26px] cursor-pointer items-center justify-center rounded-sm border px-1 text-[12px] transition-colors',
        active
          ? 'border-[#ED4259] text-[#ED4259]'
          : 'border-[#D8D2C2] text-[#969BA3] hover:border-[#ED4259] hover:text-[#ED4259]',
      )}
    >
      {children}
    </button>
  )
}

function ReadSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 9 }).map((_, i) => (
        <div
          key={i}
          className="h-[14px] animate-pulse rounded bg-black/5"
          style={{ width: i === 0 ? '42%' : `${88 + ((i * 7) % 12)}%` }}
        />
      ))}
    </div>
  )
}

/**
 * 章节正文页：独立米黄纸感皮肤 #E7E1D4 + 纸色卡片 #FBF6EC
 * 字号 A-/A/A+、行距/字体、夜间/极简模式、键盘 ←→ 翻章、回车回目录
 * 阅读偏好与其他主题共享同一份（localStorage 持久化，跨主题一致）
 */
export default function Chapter({ navigate, chapterId }: ViewProps & { chapterId: number }) {
  const { data: ch, isLoading, isError, refetch } = useChapter(chapterId)
  const [prefs] = useReaderPrefs()
  const [minimal, setMinimal] = useState(false)
  const fontSize = prefs.fontSize
  const night = prefs.scene === 'night'

  const prevId = ch?.prevId ?? null
  const nextId = ch?.nextId ?? null
  const novelId = ch?.novelId ?? null

  /* 键盘翻章（焦点在输入框/下拉/按钮上时不触发，避免误触与双重导航） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' || t.isContentEditable)) return
      if (e.key === 'ArrowLeft' && prevId) navigate({ name: 'chapter', chapterId: prevId })
      else if (e.key === 'ArrowRight' && nextId) navigate({ name: 'chapter', chapterId: nextId })
      else if (e.key === 'Enter' && novelId) navigate({ name: 'toc', novelId })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prevId, nextId, novelId, navigate])

  const paragraphs = (ch?.content ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  const pageBg = night ? 'bg-[#1B1B1F]' : 'bg-[#E7E1D4]'
  const cardBg = night ? 'bg-[#26262B]' : 'bg-[#FBF6EC]'
  const bodyText = night ? 'text-[#B9B9BF]' : 'text-[#262626]'
  const headText = night ? 'text-[#DCDCE0]' : 'text-[#555]'
  const divideColor = night ? 'divide-[#3A3A40]' : 'divide-[#E6E6E6]'
  const navText = night ? 'text-[#B9B9BF] hover:text-[#ED4259]' : 'text-[#555] hover:text-[#ED4259]'
  const disabledText = night ? 'text-[#55555C]' : 'text-[#C0C4CC]'

  return (
    <div className={cn('pb-8', pageBg)}>
      <div className={cn('mx-auto w-full px-2 pt-4', minimal ? 'max-w-[760px]' : 'max-w-[900px]')}>
        {/* 正文卡片：右上角设置面板（字号 / 夜间 / 极简） */}
        <section className={cn('relative shadow-[0_2px_14px_rgba(0,0,0,0.13)]', cardBg)}>
          <div className="absolute right-3 top-3 flex flex-wrap justify-end gap-1.5">
            <ToolBtn title="缩小字号" onClick={() => setReaderPrefs({ fontSize: stepFontSize(fontSize, -1) })}>
              A-
            </ToolBtn>
            <ToolBtn title="放大字号" onClick={() => setReaderPrefs({ fontSize: stepFontSize(fontSize, 1) })}>
              A+
            </ToolBtn>
            <select
              title="行距"
              aria-label="行距"
              value={prefs.lineHeight}
              onChange={(e) => setReaderPrefs({ lineHeight: Number(e.target.value) })}
              className={cn(
                'h-[26px] cursor-pointer rounded-sm border bg-transparent px-0.5 text-[12px] outline-none',
                night ? 'border-[#4A4A52] bg-[#26262B] text-[#B9B9BF]' : 'border-[#D8D2C2] bg-[#FBF6EC] text-[#969BA3]',
              )}
            >
              {READER_LINE_HEIGHTS.map((lh) => (
                <option key={lh} value={lh}>
                  行距 {lh.toFixed(1)}
                </option>
              ))}
            </select>
            <select
              title="字体"
              aria-label="字体"
              value={prefs.font}
              onChange={(e) => setReaderPrefs({ font: e.target.value as typeof prefs.font })}
              className={cn(
                'h-[26px] cursor-pointer rounded-sm border bg-transparent px-0.5 text-[12px] outline-none',
                night ? 'border-[#4A4A52] bg-[#26262B] text-[#B9B9BF]' : 'border-[#D8D2C2] bg-[#FBF6EC] text-[#969BA3]',
              )}
            >
              <option value="default">默认</option>
              <option value="song">宋体</option>
              <option value="hei">黑体</option>
              <option value="kai">楷体</option>
            </select>
            <ToolBtn title={night ? '日间模式' : '夜间模式'} active={night} onClick={() => setReaderPrefs({ scene: night ? 'day' : 'night' })}>
              {night ? <Sun size={13} /> : <Moon size={13} />}
            </ToolBtn>
            <ToolBtn
              title={minimal ? '标准模式' : '极简模式'}
              active={minimal}
              onClick={() => setMinimal((v) => !v)}
            >
              {minimal ? <Maximize2 size={13} /> : <Minimize2 size={13} />}
            </ToolBtn>
          </div>

          <div className={cn('px-6 pb-8 pt-10 max-[639px]:px-4', minimal && 'px-4 pt-9')}>
            {isLoading ? (
              <ReadSkeleton />
            ) : isError || !ch ? (
              <ErrorBox onRetry={() => refetch()} />
            ) : (
              <>
                <div className="flex flex-wrap items-baseline gap-2">
                  <h1 className={cn('text-[24px] font-bold leading-tight', headText)}>{ch.title}</h1>
                  <span className="text-[13px] text-[#969BA3]">（第 {ch.idx} 章）</span>
                </div>
                {!minimal && (
                  <div className="mt-1.5 flex flex-wrap gap-3 text-[12px] text-[#969BA3]">
                    <span
                      className="cursor-pointer transition-colors hover:text-[#ED4259]"
                      onClick={() => navigate({ name: 'book', novelId: ch.novelId })}
                    >
                      {ch.novelTitle}
                    </span>
                    <span>{fmtWords(ch.wordCount)}</span>
                    <span className="max-[639px]:hidden">键盘 ← → 翻章 · 回车回目录</span>
                  </div>
                )}
                <article
                  className={cn('mt-5 space-y-1 text-justify', bodyText)}
                  style={{ fontSize, lineHeight: prefs.lineHeight, fontFamily: readerFontStack(prefs.font) }}
                >
                  {paragraphs.length === 0 ? (
                    <p className="py-8 text-center opacity-60">本章内容为空，请返回目录选择其他章节。</p>
                  ) : (
                    paragraphs.map((p, i) => (
                      <p key={i} className="break-words indent-[2em]">
                        {p}
                      </p>
                    ))
                  )}
                </article>
              </>
            )}
          </div>
        </section>

        {/* 翻页导航条：3 等分 60px，上一章 / 书页·目录 / 下一章 */}
        <div className={cn('mt-[10px] grid h-[60px] grid-cols-3 divide-x', cardBg, divideColor)}>
          <button
            disabled={!prevId}
            onClick={() => prevId && navigate({ name: 'chapter', chapterId: prevId })}
            className={cn(
              'flex cursor-pointer items-center justify-center text-[18px] transition-colors',
              prevId ? navText : cn('cursor-not-allowed', disabledText),
            )}
          >
            上一章
          </button>
          <button
            onClick={() => novelId && navigate({ name: 'toc', novelId })}
            className={cn('flex cursor-pointer items-center justify-center text-[18px] transition-colors', navText)}
          >
            书页 · 目录
          </button>
          <button
            disabled={!nextId}
            onClick={() => nextId && navigate({ name: 'chapter', chapterId: nextId })}
            className={cn(
              'flex cursor-pointer items-center justify-center text-[18px] transition-colors',
              nextId ? navText : cn('cursor-not-allowed', disabledText),
            )}
          >
            {ch && !nextId ? '没有了' : '下一章'}
          </button>
        </div>
      </div>
    </div>
  )
}
