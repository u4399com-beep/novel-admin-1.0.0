'use client'

import { useState } from 'react'
import { NovelTagsRow } from '@/components/novel-tags'
import { useNovel } from '@/hooks/use-novel-data'
import type { ViewProps } from '../types'
import { BtnGray, BtnMain, Cover, ErrorBox, XLink, fmtDateFull, fmtWords, statusText } from './parts'
import Sidebar from './Sidebar'

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="border border-[#E4E4E4] bg-[#F2F2F2] px-1.5 py-[5px] text-left font-bold text-[#333]">
      {children}
    </th>
  )
}

function Td({ children, colSpan }: { children: React.ReactNode; colSpan?: number }) {
  return (
    <td colSpan={colSpan} className="border border-[#E4E4E4] px-1.5 py-[5px] text-[#666]">
      {children}
    </td>
  )
}

/**
 * 书籍详情页（Layout 完整页头 + 导航 + .footer；源站 /book/{id}.html 为
 * 左 190 排行侧栏 + 中 760 属性表格白盒布局）：
 * h1 全文阅读 → 属性表格 + 封面 → 按钮排 → 内容简介 → 书评区
 */
export default function Book({ navigate, novelId }: ViewProps & { novelId: number }) {
  const { data: novel, isLoading, isError, refetch } = useNovel(novelId)
  const [hint, setHint] = useState('')
  const [comment, setComment] = useState('')
  const [commented, setCommented] = useState(false)

  if (isLoading) {
    return (
      <div className="mt-2 min-w-0 flex-1 border border-[#E4E4E4] bg-white p-4">
        <div className="h-[24px] w-1/2 animate-pulse bg-[#EFEFEF]" />
        <div className="mt-4 flex gap-3">
          <div className="h-[166px] w-[136px] shrink-0 animate-pulse bg-[#EFEFEF]" />
          <div className="flex-1 space-y-2 pt-2">
            <div className="h-[12px] w-3/4 animate-pulse bg-[#F2F2F2]" />
            <div className="h-[12px] w-1/2 animate-pulse bg-[#F2F2F2]" />
            <div className="h-[12px] w-2/3 animate-pulse bg-[#F2F2F2]" />
          </div>
        </div>
        <div className="mt-4 space-y-2">
          <div className="h-[12px] w-full animate-pulse bg-[#F2F2F2]" />
          <div className="h-[12px] w-5/6 animate-pulse bg-[#F2F2F2]" />
          <div className="h-[12px] w-4/6 animate-pulse bg-[#F2F2F2]" />
        </div>
      </div>
    )
  }

  if (isError || !novel) {
    return (
      <div className="mt-2">
        <ErrorBox onRetry={() => refetch()} />
      </div>
    )
  }

  const lastId = novel.lastChapterId

  return (
    <div className="mt-2 flex items-start justify-between">
      <Sidebar navigate={navigate} />

      <div className="min-w-0 flex-1 lg:w-[760px] lg:max-w-[760px] lg:flex-none">
        <div className="border border-[#E4E4E4] bg-white">
          <div className="h-[2px] border-b border-[#33CCFF] bg-[#D9EDFF]" />

      {/* h1：书名 + 全文阅读 */}
      <h1 className="text-center text-[20px] leading-[65px] text-[#333]">{novel.title} 全文阅读</h1>

      {/* 信息区：封面 120×150（7px 内衬）+ 属性表格 */}
      <div className="border-t border-[#E4E4E4] px-2 py-2">
        <div className="flex gap-3 max-[1000px]:flex-col">
          <div className="shrink-0 border border-[#E4E4E4] p-[7px]">
            <Cover novel={novel} charClass="text-4xl" className="h-[150px] w-[120px]" />
          </div>
          <table className="w-full self-start border-collapse text-[12px]">
            <tbody>
              <tr>
                <Th>类别</Th>
                <Td>
                  <XLink onClick={() => navigate({ name: 'category', categoryId: novel.categoryId })}>
                    {novel.categoryName}
                  </XLink>
                </Td>
                <Th>状态</Th>
                <Td>{statusText(novel.status)}</Td>
                <Th>作者</Th>
                <Td>{novel.author}</Td>
              </tr>
              <tr>
                <Th>字数</Th>
                <Td>{fmtWords(novel.wordCount)}字</Td>
                <Th>章节</Th>
                <Td>{novel.totalChapters} 章</Td>
                <Th>总点击</Th>
                <Td>{fmtWords(novel.clicks)}</Td>
              </tr>
              <tr>
                <Th>最新</Th>
                <Td colSpan={5}>
                  {lastId != null ? (
                    <XLink onClick={() => navigate({ name: 'chapter', chapterId: lastId })}>
                      {novel.lastChapterTitle ?? '暂无章节'}
                    </XLink>
                  ) : (
                    <span>{novel.lastChapterTitle ?? '暂无章节'}</span>
                  )}
                  <span className="ml-2 text-[#999]">{fmtDateFull(novel.updatedAt)}</span>
                </Td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* 按钮行 .btnlinks：全文阅读（橙主）+ 辅助灰按钮 */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <BtnMain onClick={() => navigate({ name: 'toc', novelId })}>全文阅读</BtnMain>
          <BtnGray onClick={() => setHint('加入书架')}>加入书架</BtnGray>
          <BtnGray onClick={() => setHint('推荐本书')}>推荐本书</BtnGray>
          <BtnGray onClick={() => setHint('TXT下载')}>TXT下载</BtnGray>
          <BtnGray onClick={() => setHint('手机阅读')} className="text-[#FF3300]">
            手机阅读
          </BtnGray>
          {hint && <span className="text-[11px] text-[#FF3300]">〔{hint}〕演示模板未开放此功能</span>}
        </div>
      </div>

      {/* 内容简介 .pl */}
      <div className="mx-2 mb-2 border border-[#E4E4E4]">
        <div className="bg-[#F2F2F2] px-[10px] text-[12px] font-bold leading-[26px] text-[#333]">内容简介</div>
        <p className="indent-[2em] px-3 py-2 text-[12px] leading-[1.8] text-[#666]">
          {novel.description || '（暂无简介）'}
        </p>
        <NovelTagsRow tags={novel.tags ?? []} navigate={navigate} className="px-3 pb-2" />
        <div className="border-t border-dotted border-[#E4E4E4] px-3 py-1.5 text-[12px] text-[#999]">
          关键字：{novel.categoryName}，{novel.author}，{statusText(novel.status)} · 最近章节：
          {lastId != null ? (
            <XLink onClick={() => navigate({ name: 'chapter', chapterId: lastId })}>
              {novel.lastChapterTitle ?? '暂无'}
            </XLink>
          ) : (
            <span>{novel.lastChapterTitle ?? '暂无'}</span>
          )}
        </div>
      </div>

      {/* 书评区：评论链接行 + 发表评论表单（textarea 380px） */}
      <div className="mx-2 mb-3 border border-[#E4E4E4]">
        <div className="bg-[#F2F2F2] px-[10px] text-[12px] font-bold leading-[26px] text-[#333]">书评区</div>
        <div className="px-3 py-2 text-[12px]">
          <div className="flex items-center justify-between text-[#999]">
            <span>本书暂无书评，快来发表第一条评论吧。</span>
            <XLink
              onClick={() => {
                setHint('')
                setCommented(false)
              }}
              title="演示模板：书评列表未实现"
            >
              查看全部书评
            </XLink>
          </div>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="发表你的看法…"
            className="mt-2 h-[80px] w-[380px] max-w-full resize-none border border-[#CCCCCC] p-1 text-[12px] text-[#333] outline-none placeholder:text-[#BBB] focus:border-[#FF6600]"
          />
          <div className="mt-1 flex items-center gap-2">
            <BtnGray
              onClick={() => {
                if (!comment.trim()) return
                setCommented(true)
                setComment('')
              }}
            >
              发表评论
            </BtnGray>
            {commented && <span className="text-[#FF6600]">评论已提交（演示，不会真正保存）</span>}
          </div>
        </div>
      </div>
        </div>
      </div>
    </div>
  )
}
