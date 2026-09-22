import Link from 'next/link'

/**
 * 书页「相关搜索」内链块（共享组件，主题/服务器组件均可使用）：
 * 把 Novel.suggestKeywords（逗号分隔的搜索引擎下拉词）渲染为一组小链接，
 * 每个词指向对应的 PSEO 聚合落地页 /pseo/{encodeURIComponent(词)}（真实 URL，可被抓取内链）。
 * 空串/无有效词时不渲染任何 DOM；默认紧凑中性样式，主题可传 className 适配排版（边距/分隔线/卡片底）。
 */
export function BookSuggestLinks({ keywords, className = '' }: { keywords: string; className?: string }) {
  // 兼容中英文逗号/顿号分隔；去空白、去重后仍为空则不渲染（?? '' 兜底旧 Prisma Client 未返回该字段的过渡期）
  const words = [
    ...new Set(
      (keywords ?? '')
        .split(/[,，、]/)
        .map((w) => w.trim())
        .filter(Boolean),
    ),
  ]
  if (words.length === 0) return null
  return (
    <div className={className}>
      <span className="text-xs font-medium text-neutral-400">相关搜索</span>
      <ul className="mt-1.5 flex flex-wrap gap-2">
        {words.map((w) => (
          <li key={w}>
            {/* force-dynamic 落地页无预取价值，关闭 prefetch 避免批量词页无谓请求 */}
            <Link
              href={`/pseo/${encodeURIComponent(w)}`}
              prefetch={false}
              className="text-xs text-neutral-500 transition-colors hover:text-neutral-900 hover:underline"
            >
              {w}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
