'use client'

import { useEffect } from 'react'
import { useChapter, useNovel } from '@/hooks/use-novel-data'
import {
  READER_INKS,
  READER_LINE_HEIGHTS,
  READER_SCENES,
  readerFontStack,
  readerInk,
  resetReaderPrefs,
  setReaderPrefs,
  stepFontSize,
  useReaderPrefs,
  type ReaderSceneColors,
} from '@/hooks/use-reader-prefs'
import type { ChapterDetail } from '@/lib/types'
import type { ViewProps } from '../types'
import { ErrorBox, XLink, fmtWords } from './parts'

/* 场景配色：日间白纸（页面底色由 Layout 提供淡蓝），其余按语义键换肤 */
const SCENES: Record<string, ReaderSceneColors> = {
  day: { page: '', paper: '#ffffff', ink: '#333333', muted: '#999999', line: '#E4E4E4' },
  paper: { page: '#e6d9bd', paper: '#f8f0da', ink: '#4a3a24', muted: '#a89a80', line: '#d4c5a3' },
  green: { page: '#dcead8', paper: '#f0f6ec', ink: '#2f4030', muted: '#8fa590', line: '#bcd4bc' },
  blue: { page: '#d8e4ee', paper: '#eef4fa', ink: '#2d3c46', muted: '#8fa2b0', line: '#b8cede' },
  night: { page: '#1e2024', paper: '#26262b', ink: '#c0c0c6', muted: '#8a8a92', line: '#3a3a42' },
}

/** 章首/章尾共用导航行：上一页 | 返回目录 | 下一页（源站杰奇阅读页同款文案，无前后章时置灰） */
function NavRow({ ch, navigate }: { ch: ChapterDetail; navigate: ViewProps['navigate'] }) {
  const prevId = ch.prevId
  const nextId = ch.nextId
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-1 py-2 text-[14px]">
      {prevId != null ? (
        <XLink onClick={() => navigate({ name: 'chapter', chapterId: prevId })}>上一页</XLink>
      ) : (
        <span className="text-[#BBB]">上一页</span>
      )}
      <XLink onClick={() => navigate({ name: 'toc', novelId: ch.novelId })}>返回目录</XLink>
      {nextId != null ? (
        <XLink onClick={() => navigate({ name: 'chapter', chapterId: nextId })}>下一页</XLink>
      ) : (
        <span className="text-[#BBB]">下一页</span>
      )}
    </div>
  )
}

/** 阅读设置：字号 A± / 行距 / 字体 / 字色 / 背景（跨主题共享同一份偏好，localStorage 持久化） */
function ReaderBar() {
  const [prefs] = useReaderPrefs()
  const btn =
    'flex h-[20px] min-w-[24px] cursor-pointer items-center justify-center border border-[#CCCCCC] bg-white px-1 text-[11px] text-[#666] transition-colors hover:border-[#FF6600] hover:text-[#FF6600]'
  const on = 'border-[#FF6600] bg-[#FFF3E8] text-[#FF6600]'
  const night = prefs.scene === 'night'
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 border-b border-dotted border-[#E4E4E4] px-3 py-1.5 text-[11px] text-[#999]">
      字号
      <button className={btn} title="减小字号" onClick={() => setReaderPrefs({ fontSize: stepFontSize(prefs.fontSize, -1) })}>
        A-
      </button>
      <button className={btn} title="增大字号" onClick={() => setReaderPrefs({ fontSize: stepFontSize(prefs.fontSize, 1) })}>
        A+
      </button>
      <span className="ml-0.5 w-[40px] text-right">当前 {prefs.fontSize}px</span>
      <span className="mx-1 hidden h-[12px] w-px bg-[#E4E4E4] sm:inline-block" />
      行距
      {READER_LINE_HEIGHTS.map((lh) => (
        <button
          key={lh}
          className={`${btn} ${prefs.lineHeight === lh ? on : ''}`}
          onClick={() => setReaderPrefs({ lineHeight: lh })}
        >
          {lh.toFixed(1)}
        </button>
      ))}
      <span className="mx-1 hidden h-[12px] w-px bg-[#E4E4E4] sm:inline-block" />
      字体
      <select
        value={prefs.font}
        onChange={(e) => setReaderPrefs({ font: e.target.value as typeof prefs.font })}
        className="h-[20px] cursor-pointer border border-[#CCCCCC] bg-white px-0.5 text-[11px] text-[#666] outline-none"
      >
        <option value="default">默认</option>
        <option value="song">宋体</option>
        <option value="hei">黑体</option>
        <option value="kai">楷体</option>
      </select>
      <span className="mx-1 hidden h-[12px] w-px bg-[#E4E4E4] sm:inline-block" />
      字色
      <select
        value={prefs.ink}
        onChange={(e) => setReaderPrefs({ ink: e.target.value })}
        aria-label="字色"
        className="h-[20px] cursor-pointer border border-[#CCCCCC] bg-white px-0.5 text-[11px] text-[#666] outline-none"
      >
        {READER_INKS.map((c) => (
          <option key={c.k} value={c.v}>{c.k}</option>
        ))}
      </select>
      <span className="mx-1 hidden h-[12px] w-px bg-[#E4E4E4] sm:inline-block" />
      背景
      {READER_SCENES.map((s) => (
        <button
          key={s.key}
          title={s.label}
          aria-label={`背景：${s.label}`}
          onClick={() => setReaderPrefs({ scene: s.key })}
          className={`h-3.5 w-3.5 cursor-pointer rounded-full border transition-all ${
            prefs.scene === s.key ? 'scale-110 border-[#FF6600]' : 'border-black/25'
          }`}
          style={{ background: SCENES[s.key].paper }}
        />
      ))}
      <button className={`${btn} ml-1 ${night ? on : ''}`} title={night ? '切回日间' : '夜间模式'} onClick={() => setReaderPrefs({ scene: night ? 'day' : 'night' })}>
        {night ? '日间' : '夜间'}
      </button>
      <button className="cursor-pointer text-[11px] text-[#BBB] hover:text-[#FF6600]" onClick={resetReaderPrefs}>
        恢复
      </button>
    </div>
  )
}

/**
 * 正文页（Layout 紧凑顶栏 + #a_footer，页面底色淡蓝 #E6F3FF）：
 * 面包屑 → 白色正文盒（章名 + 章首/章尾双份导航 + 字号设置 + \n 分段缩进 2em 正文）
 */
export default function Chapter({ navigate, chapterId }: ViewProps & { chapterId: number }) {
  const q = useChapter(chapterId)
  const novel = useNovel(q.data?.novelId)
  const [prefs] = useReaderPrefs()

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [chapterId])

  if (q.isPending) return <ChapterSkeleton />

  if (q.isError || !q.data) {
    return (
      <div className="mt-2">
        <ErrorBox onRetry={() => q.refetch()} />
      </div>
    )
  }

  const ch = q.data
  const nv = novel.data
  const scene = SCENES[prefs.scene] ?? SCENES.day
  const paragraphs = ch.content
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  return (
    <div className="mt-2 min-h-screen transition-colors" style={{ background: scene.page || undefined }}>
      {/* 面包屑：首页 > 分类 > 书名 > 章节名 */}
      <div className="flex h-[30px] items-center gap-1 overflow-hidden border border-[#E4E4E4] bg-white px-2 text-[12px]">
        <span className="shrink-0 font-bold text-[#333]">当前位置：</span>
        <XLink onClick={() => navigate({ name: 'home' })} className="shrink-0">
          首页
        </XLink>
        <span className="shrink-0 text-[#CCC]">&gt;</span>
        {nv && (
          <>
            <XLink onClick={() => navigate({ name: 'category', categoryId: nv.categoryId })} className="shrink-0">
              {nv.categoryName}
            </XLink>
            <span className="shrink-0 text-[#CCC]">&gt;</span>
          </>
        )}
        <XLink onClick={() => navigate({ name: 'book', novelId: ch.novelId })} className="min-w-0 max-w-[240px] truncate">
          {ch.novelTitle}
        </XLink>
        <span className="shrink-0 text-[#CCC]">&gt;</span>
        <span className="min-w-0 truncate text-[#999]">{ch.title}</span>
        {/* 源站 dt 右侧：加入书架 | 推荐本书 | 返回书页（书架/投票为账号功能，仅保留返回书页） */}
        <XLink onClick={() => navigate({ name: 'book', novelId: ch.novelId })} className="ml-auto shrink-0">
          返回书页
        </XLink>
      </div>

      {/* 正文盒 */}
      <article className="mt-2 border transition-colors" style={{ background: scene.paper, borderColor: scene.line }}>
        <div className="h-[2px] border-b border-[#33CCFF] bg-[#D9EDFF]" />

        {/* 章名区：h1 + 章首导航 + 阅读设置 */}
        <header className="px-3 pt-1">
          {/* 源站 h1：20px 居中，line-height 65px / height 70px */}
          <h1 className="h-[70px] text-center text-[20px] font-bold leading-[65px]" style={{ color: readerInk(prefs, scene) }}>{ch.title}</h1>
          <p className="pb-1 text-center text-[11px]" style={{ color: scene.muted }}>
            第 {ch.idx} 章 · 约 {fmtWords(ch.wordCount)}字
          </p>
          <div className="border-t border-dotted" style={{ borderColor: scene.line }}>
            <NavRow ch={ch} navigate={navigate} />
          </div>
          <ReaderBar />
        </header>

        {/* 正文：源站 #contents padding 25px（约 95% 宽），\n 分段、缩进 2em，字号/行距/字体/背景可调 */}
        <div
          className="mx-auto w-[95%] py-6 break-words"
          style={{
            fontSize: prefs.fontSize,
            lineHeight: prefs.lineHeight,
            fontFamily: readerFontStack(prefs.font),
            color: readerInk(prefs, scene),
          }}
        >
          {paragraphs.length === 0 ? (
            <p className="py-6 text-center text-[12px]" style={{ color: scene.muted }}>本章暂无内容，请返回目录选择其他章节。</p>
          ) : (
            paragraphs.map((p, i) => (
              <p key={i} className="indent-[2em]">
                {p}
              </p>
            ))
          )}
        </div>

        {/* 章尾导航 */}
        <footer className="mx-3 border-t border-dotted pb-1" style={{ borderColor: scene.line }}>
          <NavRow ch={ch} navigate={navigate} />
        </footer>
      </article>
    </div>
  )
}

/* ==================== 骨架屏（同风格灰条） ==================== */

function ChapterSkeleton() {
  return (
    <div className="mt-2">
      <div className="h-[30px] w-full animate-pulse border border-[#E4E4E4] bg-[#F2F2F2]" />
      <div className="mt-2 border border-[#E4E4E4] bg-white">
        <div className="h-[2px] border-b border-[#33CCFF] bg-[#D9EDFF]" />
        <div className="mx-auto mt-3 h-[22px] w-1/2 animate-pulse bg-[#EFEFEF]" />
        <div className="mx-auto mt-2 h-[10px] w-32 animate-pulse bg-[#F2F2F2]" />
        <div className="mx-auto mt-3 h-[24px] w-1/2 animate-pulse bg-[#F2F2F2]" />
        <div className="mx-auto w-[85%] space-y-2 py-4">
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className="h-[14px] animate-pulse bg-[#F2F2F2]"
              style={{ width: `${100 - (i % 3) * 8}%` }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
