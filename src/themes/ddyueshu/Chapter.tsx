'use client'

import { useEffect, useState } from 'react'
import { useChapter, useNovel, useNovels } from '@/hooks/use-novel-data'
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
import type { ViewProps } from '../types'
import { ErrBlock, Sk, fmtWords, getMarks, toggleMark } from './parts'

/* ==================== 章节正文页（specs：大字 / 0.2em 字距 / 85% 居中 / 章首章尾双导航 + 阅读设置） ==================== */

/* 场景配色：日间沿用米黄纸面（--dd-cream），其余场景按语义键换肤 */
const SCENES: Record<string, ReaderSceneColors> = {
  day: { page: '', paper: '#f7f3e6', ink: '#444444', muted: '#b3b3b3', line: '#a6d3e8' },
  paper: { page: '#e6d9bd', paper: '#f8f0da', ink: '#4a3a24', muted: '#a89a80', line: '#d4c5a3' },
  green: { page: '#dcead8', paper: '#f0f6ec', ink: '#2f4030', muted: '#8fa590', line: '#bcd4bc' },
  blue: { page: '#d8e4ee', paper: '#eef4fa', ink: '#2d3c46', muted: '#8fa2b0', line: '#b8cede' },
  night: { page: '#1e2024', paper: '#26262b', ink: '#c0c0c6', muted: '#8a8a92', line: '#3a3a42' },
}

/** 阅读设置条：字号 A± / 行距 / 字体 / 字色 / 背景五板 / 恢复默认（跨主题共享同一份偏好） */
function SettingsBar() {
  const [prefs] = useReaderPrefs()
  const btn =
    'h-[20px] min-w-[24px] cursor-pointer border px-1.5 text-[11px] leading-[18px] transition-colors'
  const btnIdle = 'border-[#c8d4e1] text-[#667788] hover:border-[#459df5] hover:text-[#1a6fb0]'
  const btnOn = 'border-[#459df5] bg-[#e3f1fb] text-[#1a6fb0]'
  return (
    <div
      className="mx-3 mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 border-y border-dashed border-[#a6d3e8] py-1.5 text-[12px] text-[#667788]"
    >
      <span className="flex items-center gap-1">
        字号
        <button
          type="button"
          title="减小字号"
          className={`${btn} ${btnIdle}`}
          onClick={() => setReaderPrefs({ fontSize: stepFontSize(prefs.fontSize, -1) })}
        >
          A-
        </button>
        <button
          type="button"
          title="增大字号"
          className={`${btn} ${btnIdle}`}
          onClick={() => setReaderPrefs({ fontSize: stepFontSize(prefs.fontSize, 1) })}
        >
          A+
        </button>
        <span className="w-[30px] text-right text-[11px]">{prefs.fontSize}px</span>
      </span>
      <span className="flex items-center gap-1">
        行距
        {READER_LINE_HEIGHTS.map((lh) => (
          <button
            key={lh}
            type="button"
            className={`${btn} ${prefs.lineHeight === lh ? btnOn : btnIdle}`}
            onClick={() => setReaderPrefs({ lineHeight: lh })}
          >
            {lh.toFixed(1)}
          </button>
        ))}
      </span>
      <label className="flex items-center gap-1">
        字体
        <select
          value={prefs.font}
          onChange={(e) => setReaderPrefs({ font: e.target.value as typeof prefs.font })}
          className="h-[22px] cursor-pointer border border-[#c8d4e1] bg-white px-1 text-[11px] text-[#667788] outline-none"
        >
          <option value="default">默认</option>
          <option value="song">宋体</option>
          <option value="hei">黑体</option>
          <option value="kai">楷体</option>
        </select>
      </label>
      <label className="flex items-center gap-1">
        字色
        <select
          value={prefs.ink}
          onChange={(e) => setReaderPrefs({ ink: e.target.value })}
          aria-label="字色"
          className="h-[22px] cursor-pointer border border-[#c8d4e1] bg-white px-1 text-[11px] text-[#667788] outline-none"
        >
          {READER_INKS.map((c) => (
            <option key={c.k} value={c.v}>{c.k}</option>
          ))}
        </select>
      </label>
      <span className="flex items-center gap-1.5">
        背景
        {READER_SCENES.map((s) => (
          <button
            key={s.key}
            type="button"
            title={s.label}
            aria-label={`背景：${s.label}`}
            onClick={() => setReaderPrefs({ scene: s.key })}
            className={`h-4 w-4 cursor-pointer rounded-full border transition-all ${
              prefs.scene === s.key ? 'scale-110 border-[#459df5]' : 'border-black/25'
            }`}
            style={{ background: SCENES[s.key].paper }}
          />
        ))}
      </span>
      <button type="button" className="cursor-pointer text-[11px] text-[#999] hover:text-[#cc0000]" onClick={resetReaderPrefs}>
        恢复默认
      </button>
    </div>
  )
}

export default function Chapter({ navigate, siteName, chapterId }: ViewProps & { chapterId: number }) {
  const q = useChapter(chapterId)
  const novel = useNovel(q.data?.novelId)
  const hot = useNovels({ sort: 'clicks', pageSize: 10 })
  const [prefs] = useReaderPrefs()

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [chapterId])

  if (q.isPending) return <ChapterSkeleton />
  if (q.isError || !q.data) {
    return <ErrBlock msg={q.error instanceof Error ? q.error.message : ''} onRetry={() => q.refetch()} />
  }

  const ch = q.data
  const nv = novel.data
  const paragraphs = ch.content
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  /* 章首 / 章尾共用导航行（深绿链接，specs .bottem1/.bottem2） */
  const navBar = (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 py-2 text-[14px]">
      <button
        className="dd-greenlink"
        disabled={!ch.prevId}
        onClick={() => ch.prevId && navigate({ name: 'chapter', chapterId: ch.prevId })}
      >
        上一章 ←
      </button>
      <button className="dd-greenlink" onClick={() => navigate({ name: 'toc', novelId: ch.novelId })}>
        章节目录
      </button>
      <button
        className="dd-greenlink"
        disabled={!ch.nextId}
        onClick={() => ch.nextId && navigate({ name: 'chapter', chapterId: ch.nextId })}
      >
        → 下一章
      </button>
      <MarkButton key={`${ch.novelId}-${ch.id}`} novelId={ch.novelId} chapterId={ch.id} />
    </div>
  )

  /* 阅读场景换肤：纸面底色 + 文字色（用户自选字色优先） */
  const scene = SCENES[prefs.scene] ?? SCENES.day

  return (
    <div style={{ background: scene.page }} className="min-h-screen transition-colors">
      {/* 面包屑：首页 > 分类 > 书名 > 章节名 */}
      <div className="mt-1 flex h-[36px] items-center gap-1 overflow-hidden border-b border-[#a6d3e8] bg-[#e1eced] px-2 text-[13px]">
        <button className="dd-link flex-none" onClick={() => navigate({ name: 'home' })}>
          首页
        </button>
        <span className="flex-none text-[#b3b3b3]">&gt;</span>
        {nv && (
          <>
            <button
              className="dd-link flex-none"
              onClick={() => navigate({ name: 'category', categoryId: nv.categoryId, page: 1 })}
            >
              {nv.categoryName}
            </button>
            <span className="flex-none text-[#b3b3b3]">&gt;</span>
          </>
        )}
        <button className="dd-link flex-none" onClick={() => navigate({ name: 'book', novelId: ch.novelId })}>
          {ch.novelTitle}
        </button>
        <span className="flex-none text-[#b3b3b3]">&gt;</span>
        <span className="truncate text-[#667788]">{ch.title}</span>
      </div>

      {/* 正文盒（米黄底 + 3px 天蓝描边，阅读场景换肤） */}
      <article className="dd-box dd-box-strong mt-2 transition-colors" style={{ background: scene.paper }}>
        {/* 章名区（下 1px 蓝虚线）：h1 25px 黑体居中 + 章首导航 + 热门推荐行 */}
        <header className="mx-3 border-b border-dashed border-[#a6d3e8]">
          <h1 className="dd-hei pt-3 text-center text-[25px] font-bold leading-[34px] text-[#333]">{ch.title}</h1>
          <p className="pt-1 text-center text-[12px] text-[#b3b3b3]">
            第 {ch.idx} 章 · 约 {fmtWords(ch.wordCount)}
          </p>
          {navBar}
          <SettingsBar />
          {(hot.data?.list.length ?? 0) > 0 && (
            <p className="truncate pb-1.5 text-center text-[12px] text-[#999]">
              <span className="mr-1">热门推荐：</span>
              {(hot.data?.list ?? []).slice(0, 10).map((n) => (
                <button key={n.id} className="dd-link mr-1" onClick={() => navigate({ name: 'book', novelId: n.id })}>
                  《{n.title}》
                </button>
              ))}
            </p>
          )}
        </header>

        {/* 正文：可调字号/行距/字体 + 字距 0.2em + 85% 宽居中，\n 分段缩进 2em */}
        <div
          className="dd-reader-content mx-auto w-[92%] py-5 break-words tracking-[0.2em] sm:w-[85%]"
          style={{
            fontSize: prefs.fontSize,
            lineHeight: prefs.lineHeight,
            fontFamily: readerFontStack(prefs.font),
            color: readerInk(prefs, scene),
          }}
        >
          {paragraphs.length === 0 ? (
            <p className="dd-hottext text-center">本章内容为空，请返回目录选择其他章节。</p>
          ) : (
            paragraphs.map((p, i) => <p key={i}>{p}</p>)
          )}
        </div>

        {/* 章尾导航（上 1px 蓝虚线） */}
        <footer className="mx-3 border-t border-dashed border-[#a6d3e8]">
          {navBar}
          <p className="pb-2 text-center text-[12px] leading-[20px] text-[#b2b2b2]">
            <span className="dd-hottext mr-2">发现章节错误？演示站点暂未开放反馈。</span>
            请记住本站地址：{siteName}
          </p>
        </footer>
      </article>
    </div>
  )
}

/* ==================== 书签按钮（localStorage，按章重挂载 + 惰性初始化恢复已存书签） ==================== */

function MarkButton({ novelId, chapterId }: { novelId: number; chapterId: number }) {
  /* 视图仅客户端挂载（ThemeRenderer 等 settings 加载后才渲染），惰性读 storage 无水合风险 */
  const [marked, setMarked] = useState(() => getMarks(String(novelId)).includes(chapterId))
  return (
    <button
      className={marked ? 'dd-hottext cursor-pointer' : 'dd-greenlink'}
      onClick={() => setMarked(toggleMark(String(novelId), chapterId))}
    >
      {marked ? '已在书签' : '加入书签'}
    </button>
  )
}

/* ==================== 骨架屏 ==================== */

function ChapterSkeleton() {
  return (
    <div>
      <Sk className="mt-1 h-[36px] w-full" />
      <div className="dd-box dd-box-strong mt-2 px-4 py-6">
        <Sk className="mx-auto h-[30px] w-1/2" />
        <Sk className="mx-auto mt-3 h-[16px] w-40" />
        <div className="mx-auto mt-6 w-[85%] space-y-3">
          {Array.from({ length: 10 }, (_, i) => (
            <Sk key={i} className="h-[28px]" style={{ width: `${100 - (i % 3) * 9}%` }} />
          ))}
        </div>
        <Sk className="mx-auto mt-8 h-[20px] w-64" />
      </div>
    </div>
  )
}
