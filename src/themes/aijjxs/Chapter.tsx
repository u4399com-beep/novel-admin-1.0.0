'use client'

import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useChapters, useChapter } from '@/hooks/use-novel-data'
import type { ViewProps } from '../types'
import { ErrBlock, fmtWords, markRead, Sk } from './parts'

/* ---------- 阅读器设置 ---------- */

const SIZES = [
  { k: '小', px: 19 },
  { k: '中', px: 21 },
  { k: '大', px: 23 },
  { k: '加大', px: 25 },
  { k: '极大', px: 28 },
]
const BGS = [
  { k: '纸白', page: '#efe6d8', paper: '#fffcf6', ink: '#3d3327' },
  { k: '羊皮', page: '#e6d9bd', paper: '#f8f0da', ink: '#4a3a24' },
  { k: '青竹', page: '#e2ecdf', paper: '#f1f6ee', ink: '#2f4030' },
  { k: '湖水', page: '#dfe8f0', paper: '#eef3f8', ink: '#2d3c46' },
  { k: '暖沙', page: '#ecdfce', paper: '#f9f1e4', ink: '#42342a' },
  { k: '夜间', page: '#26251f', paper: '#31302a', ink: '#c9c2b2' },
]
const FONTS = [
  { k: '默认', v: 'inherit' },
  { k: '宋体', v: 'SimSun, "宋体", serif' },
  { k: '雅黑', v: '"Microsoft YaHei", "PingFang SC", sans-serif' },
  { k: '楷体', v: 'KaiTi, STKaiti, "楷体", serif' },
  { k: '黑体', v: 'SimHei, "黑体", sans-serif' },
]
const INKS = [
  { k: '跟随背景', v: '' },
  { k: '深棕', v: '#5b4636' },
  { k: '墨绿', v: '#234d3f' },
  { k: '藏蓝', v: '#2c3e5d' },
  { k: '炭黑', v: '#262626' },
]

interface ReaderSetting {
  size: number
  bg: number
  font: number
  ink: number
}
const DEFAULT_SETTING: ReaderSetting = { size: 2, bg: 0, font: 0, ink: 0 }
const LS_KEY = 'aj-reader-setting'

export default function Chapter({ navigate, chapterId }: ViewProps & { chapterId: number }) {
  const ch = useChapter(chapterId)
  const all = useChapters(ch.data?.novelId)
  /* 阅读器设置：惰性初始化（客户端专属视图，无 SSR 水合风险）+ 变更时持久化 */
  const [setting, setSetting] = useState<ReaderSetting>(() => {
    try {
      const raw = window.localStorage.getItem(LS_KEY)
      if (raw) return { ...DEFAULT_SETTING, ...(JSON.parse(raw) as Partial<ReaderSetting>) }
    } catch {
      /* 忽略 */
    }
    return DEFAULT_SETTING
  })
  useEffect(() => {
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify(setting))
    } catch {
      /* 忽略 */
    }
  }, [setting])

  /* 记录已读章节 */
  useEffect(() => {
    if (ch.data) markRead('aj-read', ch.data.id)
  }, [ch.data])

  /* ← → 键盘翻章 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
  const bg = BGS[setting.bg] ?? BGS[0]
  const size = (SIZES[setting.size] ?? SIZES[2]).px
  const font = (FONTS[setting.font] ?? FONTS[0]).v
  const ink = (INKS[setting.ink] ?? INKS[0]).v || bg.ink
  const paragraphs = c.content
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const total = all.data?.length ?? 0
  const chapters = all.data ?? []

  const rootStyle = {
    '--r-bg': bg.page,
    '--r-paper': bg.paper,
    '--r-ink': ink,
    fontSize: `${size}px`,
    fontFamily: font,
  } as CSSProperties

  return (
    <div className="aj-reader pb-10" style={rootStyle}>
      {/* 阅读工具条：背景色 6 板 / 字号 5 档 / 字体 / 字色 */}
      <div className="aj-reader-paper mx-auto w-[calc(100%-24px)] max-w-[1080px] px-4 py-3 sm:w-[94%]">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs" style={{ color: 'var(--r-ink)' }}>
          <div className="flex items-center gap-1.5">
            <span className="mr-0.5 opacity-80">背景</span>
            {BGS.map((b, i) => (
              <button
                key={b.k}
                title={b.k}
                aria-label={`背景：${b.k}`}
                data-active={i === setting.bg}
                className="aj-swatch"
                style={{ background: b.paper }}
                onClick={() => setSetting((s) => ({ ...s, bg: i }))}
              />
            ))}
          </div>
          <div className="flex items-center gap-1">
            <span className="mr-0.5 opacity-80">字号</span>
            {SIZES.map((s, i) => (
              <button
                key={s.k}
                data-active={i === setting.size}
                className="aj-reader-btn"
                onClick={() => setSetting((v) => ({ ...v, size: i }))}
              >
                {s.k}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1">
            <span className="opacity-80">字体</span>
            <select
              className="aj-reader-select"
              value={setting.font}
              onChange={(e) => setSetting((v) => ({ ...v, font: Number(e.target.value) }))}
            >
              {FONTS.map((f, i) => (
                <option key={f.k} value={i}>
                  {f.k}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            <span className="opacity-80">字色</span>
            <select
              className="aj-reader-select"
              value={setting.ink}
              onChange={(e) => setSetting((v) => ({ ...v, ink: Number(e.target.value) }))}
            >
              {INKS.map((f, i) => (
                <option key={f.k} value={i}>
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

      {/* 正文卡：23px / 1.76 / 缩进 2.4em */}
      <article
        className="aj-reader-paper mx-auto mt-4 w-[calc(100%-24px)] max-w-[1080px] px-[clamp(24px,4vw,40px)] py-[clamp(24px,4vw,40px)] leading-[1.76] sm:w-[94%]"
        style={{ color: 'var(--r-ink)' }}
      >
        {paragraphs.map((p, i) => (
          <p key={i} className="aj-reader-para">
            {p}
          </p>
        ))}
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
