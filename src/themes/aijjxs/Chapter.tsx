'use client'

import { useEffect } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useChapters, useChapter } from '@/hooks/use-novel-data'
import {
  READER_FONTS,
  READER_INKS,
  READER_LINE_HEIGHTS,
  READER_SCENES,
  readerFontStack,
  setReaderPrefs,
  useReaderPrefs,
  type ReaderSceneColors,
} from '@/hooks/use-reader-prefs'
import type { ViewProps } from '../types'
import { ErrBlock, fmtWords, markRead, Sk } from './parts'

/* ---------- 阅读器设置（与其他主题共享同一份偏好，localStorage 持久化、跨主题一致） ---------- */

const SIZES = [
  { k: '小', px: 19 },
  { k: '中', px: 21 },
  { k: '大', px: 23 },
  { k: '加大', px: 25 },
  { k: '极大', px: 28 },
]

/** 场景配色（与其他主题语义对齐：日间/羊皮/护眼/淡蓝/夜间，暖纸调色板保留） */
const SCENES: Record<string, ReaderSceneColors> = {
  day: { page: '#efe6d8', paper: '#fffcf6', ink: '#3d3327', muted: '#8a7a64', line: '#d8c9ae' },
  paper: { page: '#e6d9bd', paper: '#f8f0da', ink: '#4a3a24', muted: '#a89a80', line: '#d4c5a3' },
  green: { page: '#e2ecdf', paper: '#f1f6ee', ink: '#2f4030', muted: '#8fa590', line: '#c2d6c2' },
  blue: { page: '#dfe8f0', paper: '#eef3f8', ink: '#2d3c46', muted: '#8fa2b0', line: '#c2d2e0' },
  night: { page: '#26251f', paper: '#31302a', ink: '#c9c2b2', muted: '#8f897b', line: '#45443c' },
}

/* 字色预设共享自 use-reader-prefs（READER_INKS），与其他主题同一份 */

export default function Chapter({ navigate, chapterId }: ViewProps & { chapterId: number }) {
  const ch = useChapter(chapterId)
  const all = useChapters(ch.data?.novelId)
  const [prefs] = useReaderPrefs()

  /* 记录已读章节 */
  useEffect(() => {
    if (ch.data) markRead('aj-read', ch.data.id)
  }, [ch.data])

  /* ← → 键盘翻章（焦点在输入框/下拉/按钮上时不触发，避免与表单控件冲突） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' || t.isContentEditable)) return
      if (e.key === 'ArrowLeft' && ch.data?.prevId) navigate({ name: 'chapter', chapterId: ch.data.prevId })
      if (e.key === 'ArrowRight' && ch.data?.nextId) navigate({ name: 'chapter', chapterId: ch.data.nextId })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ch.data, navigate])

  if (ch.isPending) return <ReaderSkeleton />
  if (ch.isError || !ch.data) {
    return <ErrBlock msg={ch.error instanceof Error ? ch.error.message : ''} onRetry={() => ch.refetch()} />
  }

  const c = ch.data
  /* 场景配色 + 就近字号档位（偏好可能来自其他主题的自定义字号） */
  const scene = SCENES[prefs.scene] ?? SCENES.day
  const sizeIdx = SIZES.reduce(
    (best, s, i) => (Math.abs(s.px - prefs.fontSize) < Math.abs(SIZES[best].px - prefs.fontSize) ? i : best),
    0,
  )
  const ink = prefs.ink || scene.ink
  /* 两阶段采集：章节骨架先入库、正文异步回填——content 为空/纯空白时渲染占位 */
  const paragraphs = (c.content ?? '')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const total = all.data?.length ?? 0
  const chapters = all.data ?? []

  const rootStyle = {
    '--r-bg': scene.page,
    '--r-paper': scene.paper,
    '--r-ink': ink,
    fontSize: `${prefs.fontSize}px`,
    fontFamily: readerFontStack(prefs.font),
  } as CSSProperties

  return (
    <div className="aj-reader pb-10" style={rootStyle}>
      {/* 阅读工具条：背景色 5 板 / 字号 5 档 / 行距 / 字体 / 字色（跨主题共享） */}
      <div className="aj-reader-paper mx-auto w-[calc(100%-24px)] max-w-[1080px] px-4 py-3 sm:w-[94%]">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs" style={{ color: 'var(--r-ink)' }}>
          <div className="flex items-center gap-1.5">
            <span className="mr-0.5 opacity-80">背景</span>
            {READER_SCENES.map((s) => (
              <button
                key={s.key}
                title={s.label}
                aria-label={`背景：${s.label}`}
                data-active={prefs.scene === s.key}
                className="aj-swatch"
                style={{ background: SCENES[s.key].paper }}
                onClick={() => setReaderPrefs({ scene: s.key })}
              />
            ))}
          </div>
          <div className="flex items-center gap-1">
            <span className="mr-0.5 opacity-80">字号</span>
            {SIZES.map((s, i) => (
              <button
                key={s.k}
                data-active={i === sizeIdx}
                className="aj-reader-btn"
                onClick={() => setReaderPrefs({ fontSize: s.px })}
              >
                {s.k}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <span className="mr-0.5 opacity-80">行距</span>
            {READER_LINE_HEIGHTS.map((lh) => (
              <button
                key={lh}
                data-active={prefs.lineHeight === lh}
                className="aj-reader-btn"
                onClick={() => setReaderPrefs({ lineHeight: lh })}
              >
                {lh.toFixed(1)}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1">
            <span className="opacity-80">字体</span>
            <select
              className="aj-reader-select"
              value={prefs.font}
              onChange={(e) => setReaderPrefs({ font: e.target.value as typeof prefs.font })}
            >
              {READER_FONTS.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            <span className="opacity-80">字色</span>
            <select
              className="aj-reader-select"
              value={prefs.ink}
              onChange={(e) => setReaderPrefs({ ink: e.target.value })}
            >
              {READER_INKS.map((f) => (
                <option key={f.k} value={f.v}>
                  {f.k}
                </option>
              ))}
            </select>
          </label>
          <span className="ml-auto hidden opacity-60 sm:inline">键盘 ← → 可翻章</span>
        </div>
      </div>

      {/* 章节标题卡 */}
      <div
        className="aj-reader-paper mx-auto mt-4 w-[calc(100%-24px)] max-w-[1080px] px-[clamp(20px,4vw,40px)] py-5 text-center sm:w-[94%]"
        style={{ color: 'var(--r-ink)' }}
      >
        <p className="text-[13px] opacity-70">{c.novelTitle}</p>
        <h1 className="mt-1 text-[22px] font-bold leading-snug sm:text-[26px]">{c.title}</h1>
        <div
          className="mx-auto mt-3 flex max-w-[560px] flex-wrap items-center justify-center gap-x-4 gap-y-1 border-t border-dashed pt-2.5 text-xs opacity-75"
          style={{ borderColor: 'var(--r-accent)' }}
        >
          <span>第 {c.idx} 章</span>
          {total > 0 && <span>全书共 {total} 章</span>}
          <span>{fmtWords(c.wordCount)}</span>
          <span>约 {Math.max(1, Math.ceil(c.wordCount / 500))} 分钟读完</span>
        </div>
      </div>

      {/* 正文卡：字号/行距/字体/背景/字色全部可调 */}
      <article
        className="aj-reader-paper mx-auto mt-4 w-[calc(100%-24px)] max-w-[1080px] px-[clamp(24px,4vw,40px)] py-[clamp(24px,4vw,40px)] sm:w-[94%]"
        style={{ color: 'var(--r-ink)', lineHeight: prefs.lineHeight }}
      >
        {paragraphs.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-[15px] font-bold" style={{ color: 'var(--r-accent)' }}>
              章节内容正在采集中
            </p>
            <p className="mt-2 text-sm opacity-75">
              正文回填需要一点时间，请稍后刷新重试；也可以先返回目录阅读其他章节。
            </p>
            <div className="mt-4">
              <button className="aj-reader-btn" onClick={() => window.location.reload()}>
                刷新重试
              </button>
            </div>
          </div>
        ) : (
          paragraphs.map((p, i) => (
            <p key={i} className="aj-reader-para break-words">
              {p}
            </p>
          ))
        )}
      </article>

      {/* 翻页条 */}
      <div className="aj-reader-paper mx-auto mt-4 w-[calc(100%-24px)] max-w-[1080px] px-4 py-3.5 sm:w-[94%]">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <ReaderBtn
            disabled={total === 0}
            onClick={() => {
              if (chapters[0]) navigate({ name: 'chapter', chapterId: chapters[0].id })
            }}
          >
            第一章
          </ReaderBtn>
          <ReaderBtn
            disabled={!c.prevId}
            onClick={() => {
              if (c.prevId) navigate({ name: 'chapter', chapterId: c.prevId })
            }}
          >
            上一章
          </ReaderBtn>
          <ReaderBtn onClick={() => navigate({ name: 'toc', novelId: c.novelId })}>章节目录</ReaderBtn>
          <ReaderBtn
            disabled={!c.nextId}
            onClick={() => {
              if (c.nextId) navigate({ name: 'chapter', chapterId: c.nextId })
            }}
          >
            下一章
          </ReaderBtn>
          <ReaderBtn
            disabled={total === 0}
            onClick={() => {
              if (chapters.length > 0) navigate({ name: 'chapter', chapterId: chapters[chapters.length - 1].id })
            }}
          >
            末一章
          </ReaderBtn>
          <ReaderBtn onClick={() => navigate({ name: 'book', novelId: c.novelId })}>返回书页</ReaderBtn>
        </div>
        {total > 0 && (
          <div
            className="mt-3 flex flex-wrap items-center justify-center gap-2 text-xs"
            style={{ color: 'var(--r-ink)' }}
          >
            <span className="opacity-70">共 {total} 章 · 跳转章节</span>
            <select
              className="aj-reader-select"
              value={c.id}
              onChange={(e) => navigate({ name: 'chapter', chapterId: Number(e.target.value) })}
            >
              {chapters.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.idx}. {x.title}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    </div>
  )
}

function ReaderBtn({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} className="aj-reader-btn">
      {children}
    </button>
  )
}

/* ==================== 骨架屏 ==================== */

function ReaderSkeleton() {
  return (
    <div className="aj-reader pb-10">
      <div className="aj-reader-paper mx-auto w-[calc(100%-24px)] max-w-[1080px] px-4 py-3 sm:w-[94%]">
        <Sk className="h-6 w-full" />
      </div>
      <div className="aj-reader-paper mx-auto mt-4 w-[calc(100%-24px)] max-w-[1080px] px-8 py-6 sm:w-[94%]">
        <Sk className="mx-auto h-7 w-2/3" />
        <div className="mt-6 space-y-4">
          {Array.from({ length: 10 }).map((_, i) => (
            <Sk key={i} className="h-5" style={{ width: `${94 - (i % 4) * 9}%` }} />
          ))}
        </div>
      </div>
    </div>
  )
}
