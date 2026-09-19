/**
 * 封面双形态渲染件：本地 webp 图片 / 渐变 token 统一入口。
 *
 * 存储契约（与入库层 src/lib/covers-store.ts 约定）：
 * - Novel.cover = 渐变 token（g1-g12）或本地封面路径（/covers/{novelId}.webp）
 *
 * 用法（各主题封面容器内）：
 * - 容器保持 coverBgClass(novel.cover) 渐变 + 书名首字（渐变形态视觉不变）；
 * - 容器需 relative + overflow-hidden（多数主题已有；无则补）；
 * - 容器内首个子元素插入 <NovelCoverImg novel={novel} /> —— 本地封面时渲染
 *   绝对定位铺满的 <img> 盖住渐变，渐变 token 时渲染 null；
 * - 书名首字 span 用 isLocalCover 包条件，图片形态不再渲染首字。
 */
import { cn } from '@/lib/utils'

/** cover 值是否为本地封面路径（/covers/*.webp） */
export function isLocalCover(cover: string | undefined | null): boolean {
  return typeof cover === 'string' && cover.startsWith('/covers/')
}

/**
 * 本地封面图层：仅当 cover 为本地路径时渲染 <img>（绝对定位铺满父容器），
 * 渐变 token 时渲染 null（父容器自带渐变 + 首字照常展示）。
 */
export function NovelCoverImg({
  novel,
  className,
}: {
  novel: { title: string; cover: string }
  className?: string
}) {
  if (!isLocalCover(novel.cover)) return null
  return (
    <img
      src={novel.cover}
      alt={`《${novel.title}》封面`}
      loading="lazy"
      decoding="async"
      draggable={false}
      className={cn('absolute inset-0 h-full w-full object-cover', className)}
    />
  )
}
