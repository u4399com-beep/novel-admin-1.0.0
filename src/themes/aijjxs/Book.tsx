'use client'

import { useState } from 'react'
import type { ReactNode } from 'react'
import { useNovel, useNovels } from '@/hooks/use-novel-data'
import { cn } from '@/lib/utils'
import type { ThemeView, ViewProps } from '../types'
import {
  Cover,
  CoverCard,
  ErrBlock,
  fmtDate,
  fmtNum,
  fmtWords,
  Panel,
  RankList,
  Sk,
  SkRows,
  avatarGradient,
} from './parts'

export default function Book({ navigate, novelId }: ViewProps & { novelId: number }) {
  const novel = useNovel(novelId)
  const rel = useNovels({ categoryId: novel.data?.categoryId, pageSize: 4 })
  const side = useNovels({ categoryId: novel.data?.categoryId, sort: 'clicks', pageSize: 10 })

  if (novel.isPending) return <BookSkeleton />
  if (novel.isError || !novel.data) {
    return <ErrBlock msg={novel.error instanceof Error ? novel.error.message : ''} onRetry={() => novel.refetch()} />
  }

  const n = novel.data
  const related = (rel.data?.list ?? []).filter((x) => x.id !== n.id).slice(0, 4)

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_330px]">
      {/* 左主栏 */}
      <div className="min-w-0 space-y-4">
        {/* ① 书籍信息：三列 Grid（封面 / kv / 作者卡） */}
        <Panel title={n.title} extra={n.status === 'finished' ? <span className="aj-pill aj-pill-done">已完结</span> : <span className="aj-pill aj-pill-serial">连载中</span>}>
          <div className="grid gap-4 sm:grid-cols-[112px_minmax(0,1fr)] lg:grid-cols-[112px_minmax(0,1fr)_235px]">
            {/* 左列：封面 112×148 白底灰边无圆角 */}
            <div>
              <Cover novel={n} className="h-[148px] w-[112px]" rounded="rounded-none" charClass="text-[30px]" />
              <FavButton novelId={n.id} />
            </div>
            {/* 中列：kv 信息 */}
            <div className="min-w-0">
              <dl className="text-[14px] leading-[1.9]">
                <Kv k="作者">
                  <button
                    onClick={() => navigate({ name: 'search', query: n.author })}
                    className="cursor-pointer text-[#115e59] underline-offset-2 hover:text-[#0f766e] hover:underline"
                  >
                    {n.author}
                  </button>
                </Kv>
                <Kv k="分类">
                  <button
                    onClick={() => navigate({ name: 'category', categoryId: n.categoryId, page: 1 })}
                    className="cursor-pointer text-[#115e59] underline-offset-2 hover:text-[#0f766e] hover:underline"
                  >
                    {n.categoryName}
                  </button>
                </Kv>
                <Kv k="写作进度">
                  {n.status === 'finished' ? (
                    <span className="aj-pill aj-pill-done">已完结</span>
                  ) : (
                    <span className="aj-pill aj-pill-serial">连载中</span>
                  )}
                </Kv>
                <Kv k="总字数">{fmtWords(n.wordCount)}</Kv>
                <Kv k="总点击">{fmtNum(n.clicks)}</Kv>
                <Kv k="章节">{n.totalChapters} 章</Kv>
                <Kv k="更新时间">{fmtDate(n.updatedAt)}</Kv>
                <Kv k="下载方式">在线阅读 / TXT下载（演示）</Kv>
              </dl>
            </div>
            {/* 右列：作者侧栏卡（橙虚线边 米白底） */}
            <div className="rounded-[12px] border border-dashed border-[#da5627]/70 bg-[#fffaf0] p-3.5">
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    'flex h-[52px] w-[52px] flex-none items-center justify-center rounded-full bg-gradient-to-br text-[20px] font-bold text-white shadow-sm',
                    avatarGradient(n.id)
                  )}
                >
                  {n.author.slice(0, 1)}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[16px] font-bold text-[#7c2d12]">{n.author}</p>
                  <p className="text-xs text-[#9ca3af]">TA 在本站的 bookshelf</p>
                </div>
              </div>
              <div className="mt-3 border-t border-dashed border-[#e5b78f] pt-2.5">
                <p className="text-xs text-[#8a6d3b]">已收录作品（{1} 部）</p>
                <button
                  onClick={() => navigate({ name: 'book', novelId: n.id })}
                  className="aj-row mt-1 w-full text-[13px]"
                >
                  <span className="aj-row-title flex-1">{n.title}</span>
                </button>
              </div>
              <button
                onClick={() => navigate({ name: 'search', query: n.author })}
                className="mt-3 w-full cursor-pointer rounded-[8px] border border-[#da5627]/50 py-1.5 text-center text-xs text-[#b45309] transition-colors hover:bg-[#da5627] hover:text-white"
              >
                搜索该作者全部作品 →
              </button>
            </div>
          </div>
        </Panel>

        {/* ② 内容简介（超长折叠） */}
        <Panel title="内容简介">
          <FoldText text={n.description || '暂无简介'} />
        </Panel>

        {/* ③ 下载与说明（双主按钮 + TIP 提示框） */}
        <Panel title="下载与在线阅读">
          <div className="flex flex-wrap gap-3">
            <button
              onClick={() => {
                if (n.firstChapterId) navigate({ name: 'chapter', chapterId: n.firstChapterId })
              }}
              disabled={!n.firstChapterId}
              className="aj-btn aj-btn-fire w-[184px]"
            >
              在线阅读全文
            </button>
            <button onClick={() => navigate({ name: 'toc', novelId: n.id })} className="aj-btn aj-btn-fire w-[184px]">
              章节目录 / TXT下载
            </button>
          </div>
          <div className="mt-3 flex items-start gap-2 rounded-[10px] border border-dashed border-[#b45309]/50 bg-[#fffbeb] px-3.5 py-2.5 text-[13px] leading-[1.7] text-[#8a6d3b]">
            <span className="aj-badge mt-0.5">TIP</span>
            <span>
              本站为演示站点，TXT 下载未开放；点击「在线阅读全文」直接进入第一章，或前往「章节目录」挑选任意章节阅读。
            </span>
          </div>
        </Panel>

        {/* ④ 猜您喜欢（grid2 封面卡） */}
        {related.length > 0 && (
          <Panel title="猜您喜欢">
            <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
              {related.map((x) => (
                <CoverCard key={x.id} novel={x} navigate={navigate} />
              ))}
            </div>
          </Panel>
        )}
      </div>

      {/* 右侧栏 */}
      <aside className="min-w-0 space-y-4 self-start lg:sticky lg:top-[70px]">
        <Panel title="同类热门榜" bodyClassName="p-3">
          {side.isPending ? (
            <SkRows rows={8} />
          ) : side.isError ? (
            <ErrBlock onRetry={() => side.refetch()} />
          ) : (
            <RankList novels={(side.data?.list ?? []).filter((x) => x.id !== n.id)} navigate={navigate} />
          )}
        </Panel>
        <Panel title="本书导航" bodyClassName="p-2">
          <SideLink label="返回分类列表" onClick={() => navigate({ name: 'category', categoryId: n.categoryId, page: 1 })} />
          <SideLink label="全部章节目录" onClick={() => navigate({ name: 'toc', novelId: n.id })} />
          <SideLink
            label="从第一章开始读"
            onClick={() => {
              if (n.firstChapterId) navigate({ name: 'chapter', chapterId: n.firstChapterId })
            }}
          />
          <SideLink
            label="跳到最新章节"
            onClick={() => {
              if (n.lastChapterId) navigate({ name: 'chapter', chapterId: n.lastChapterId })
            }}
          />
          <SideLink label="站内搜索" onClick={() => navigate({ name: 'search', query: '' })} />
        </Panel>
      </aside>
    </div>
  )
}

/* ==================== 小组件 ==================== */

function Kv({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex gap-2 py-[3px]">
      <dt className="w-16 flex-none text-[#6b7280]">{k}</dt>
      <dd className="min-w-0 text-[#1f2937]">{children}</dd>
    </div>
  )
}

function FavButton({ novelId }: { novelId: number }) {
  const [fav, setFav] = useState(false)
  return (
    <button
      onClick={() => setFav((v) => !v)}
      className={cn(
        'mt-1.5 w-full cursor-pointer rounded-[6px] border py-1 text-center text-xs transition-colors',
        fav
          ? 'border-[#b45309] bg-[#b45309] text-white'
          : 'border-[#e5dccd] bg-white text-[#6b7280] hover:border-[#b45309] hover:text-[#b45309]'
      )}
      aria-label={`收藏书籍 ${novelId}`}
    >
      {fav ? '已收藏 ♥' : '加入收藏'}
    </button>
  )
}

function FoldText({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <p
        className={cn(
          'text-[15px] leading-[1.8] text-[#374151]',
          !open && 'line-clamp-4'
        )}
      >
        {text}
      </p>
      <button
        onClick={() => setOpen((o) => !o)}
        className="mt-1 cursor-pointer text-[13px] font-semibold text-[#0f766e] hover:underline"
      >
        {open ? '收起 ↑' : '展开全部 ↓'}
      </button>
    </div>
  )
}

function SideLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div className="aj-row" onClick={onClick}>
      <span className="aj-row-title flex-1">{label}</span>
      <span className="flex-none text-xs text-[#c2854f]">→</span>
    </div>
  )
}

/* ==================== 骨架屏 ==================== */

function BookSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_330px]">
      <div className="min-w-0 space-y-4">
        <div className="aj-card p-4">
          <Sk className="mb-4 h-6 w-1/3" />
          <div className="flex gap-4">
            <Sk className="h-[148px] w-[112px] flex-none" />
            <div className="min-w-0 flex-1 space-y-2.5">
              <Sk className="h-4 w-2/3" />
              <Sk className="h-4 w-1/2" />
              <Sk className="h-4 w-3/5" />
              <Sk className="h-4 w-1/2" />
            </div>
          </div>
        </div>
        <div className="aj-card p-4">
          <Sk className="mb-4 h-5 w-28" />
          <SkRows rows={4} />
        </div>
      </div>
      <div className="min-w-0 space-y-4">
        <div className="aj-card p-4">
          <Sk className="mb-4 h-5 w-24" />
          <SkRows rows={8} />
        </div>
      </div>
    </div>
  )
}
