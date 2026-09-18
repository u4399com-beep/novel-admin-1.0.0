'use client'

/**
 * 管理后台各功能面板（自 AdminDrawer.tsx 迁入）：
 * ThemesTab / NovelsTab / ChaptersDialog / CategoriesTab / SeoTab /
 * PseoTab / SettingsTab + 相关类型与常量。
 *
 * 通用能力（api / runBusy / useDialogEscape / Field / Modal / DialogActions）
 * 收敛至 ./ui-shared，此处只保留各面板差异逻辑；行为与样式与拆分前一致。
 */

import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Trash2, Pencil, Plus, BookOpen, Layers } from 'lucide-react'
import { THEME_LIST } from '@/themes/registry'
import { useAppStore } from '@/lib/store'
import { useChapters, useNovels, useSettings, qk } from '@/hooks/use-novel-data'
import type { CategoryDto, NovelListItem, SeoConfig } from '@/lib/types'
import { formatWordCount, timeAgo } from '@/lib/format'
import { useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { api, errMsg, runBusy, useDialogEscape, Field, Modal, DialogActions } from './ui-shared'

/** 顺序失效多个 query（保持与逐条 await 相同的完成次序） */
async function invalidate(qc: QueryClient, ...keys: QueryKey[]) {
  for (const key of keys) await qc.invalidateQueries({ queryKey: key })
}

// ==================== 主题管理 ====================

export function ThemesTab() {
  const { data: settings, refetch } = useSettings()
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)

  const activate = (id: string) =>
    runBusy(setBusy, id, null, '切换失败', async () => {
      await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ activeTheme: id }) })
      await qc.invalidateQueries({ queryKey: qk.settings })
      refetch()
      toast.success('主题已切换')
    })

  return (
    <div>
      <p className="mb-4 text-xs text-neutral-500">
        共 {THEME_LIST.length} 套结构级主题模板（首页/分类/书页/目录/章节/搜索全套）。当前激活：
        <Badge className="ml-1">{settings?.activeTheme ?? '-'}</Badge>
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {THEME_LIST.map((t) => {
          const active = settings?.activeTheme === t.id
          return (
            <div
              key={t.id}
              className={`rounded-lg border p-4 transition ${active ? 'border-neutral-900 ring-1 ring-neutral-900' : 'border-neutral-200 hover:border-neutral-400'}`}
            >
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 overflow-hidden rounded-md" aria-hidden>
                  <div className="h-full w-1/2" style={{ background: t.swatch[0] }} />
                  <div className="h-full w-1/2" style={{ background: t.swatch[1] }} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{t.name}</p>
                  <p className="truncate text-xs text-neutral-500">{t.source}</p>
                </div>
                {active ? (
                  <Badge>使用中</Badge>
                ) : (
                  <Button size="sm" disabled={busy === t.id} onClick={() => activate(t.id)}>
                    {busy === t.id ? '切换中…' : '启用'}
                  </Button>
                )}
              </div>
              <p className="mt-2 line-clamp-2 text-xs text-neutral-500">{t.description}</p>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ==================== 书籍管理 ====================

interface NovelForm {
  id?: number
  title: string
  author: string
  description: string
  categoryId: number | 0
  status: 'serial' | 'finished'
  isFeatured: boolean
  isHot: boolean
}

const EMPTY_FORM: NovelForm = { title: '', author: '', description: '', categoryId: 0, status: 'serial', isFeatured: false, isHot: false }

/** 手写 select 与原生控件的统一外观（新增/编辑小说对话框内） */
const selectCls = 'h-9 w-full rounded-md border border-neutral-200 px-2 text-sm'

export function NovelsTab() {
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const { data } = useNovels({ q, page, pageSize: 15 })
  const { data: categories } = useQuery({ queryKey: qk.categories, queryFn: () => api<CategoryDto[]>('/api/categories') })
  const qc = useQueryClient()
  const [form, setForm] = useState<NovelForm | null>(null)
  const [chapterNovel, setChapterNovel] = useState<NovelListItem | null>(null)
  const [saving, setSaving] = useState(false)

  useDialogEscape(() => setForm(null), form !== null)

  const save = () => {
    if (!form) return
    if (!form.title.trim()) return toast.error('书名不能为空')
    if (!form.categoryId) return toast.error('请选择分类')
    return runBusy(setSaving, true, false, '保存失败', async () => {
      if (form.id) {
        await api(`/api/novels/${form.id}`, { method: 'PUT', body: JSON.stringify(form) })
        toast.success('已保存')
      } else {
        await api('/api/novels', { method: 'POST', body: JSON.stringify(form) })
        toast.success('已新增')
      }
      setForm(null)
      // categories 也失效：列表页的 novelCount 随新增/更新（换分类）变化
      await invalidate(qc, ['novels'], ['novel'], qk.home, qk.categories)
    })
  }

  const remove = async (n: NovelListItem) => {
    if (!confirm(`确认删除《${n.title}》及其全部章节？此操作不可恢复。`)) return
    try {
      await api(`/api/novels/${n.id}`, { method: 'DELETE' })
      toast.success('已删除')
      // 末页删空自愈：当前页仅剩这一条且不是第一页时回退一页，避免停留在空页
      if (data && data.list.length === 1 && page > 1) setPage(page - 1)
      await invalidate(qc, ['novels'], ['novel'], qk.home, qk.categories)
    } catch (e) {
      toast.error(errMsg(e, '删除失败'))
    }
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input placeholder="搜索书名/作者" value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} className="h-9 max-w-48" />
        <Button size="sm" onClick={() => setForm({ ...EMPTY_FORM })}><Plus className="mr-1 h-3.5 w-3.5" />新增小说</Button>
      </div>
      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-xs text-neutral-500">
            <tr>
              <th className="px-3 py-2 text-left font-medium">书名</th>
              <th className="hidden px-3 py-2 text-left font-medium sm:table-cell">分类</th>
              <th className="px-3 py-2 text-left font-medium">章节</th>
              <th className="hidden px-3 py-2 text-left font-medium md:table-cell">字数</th>
              <th className="px-3 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {data?.list.map((n) => (
              <tr key={n.id} className="border-t">
                <td className="max-w-36 truncate px-3 py-2">
                  {n.title}
                  <span className="ml-1 text-xs text-neutral-400">{n.author}</span>
                  {n.isFeatured && <Badge className="ml-1 px-1 py-0 text-[10px]">荐</Badge>}
                  {n.isHot && <Badge variant="secondary" className="ml-1 px-1 py-0 text-[10px]">热</Badge>}
                </td>
                <td className="hidden px-3 py-2 text-xs text-neutral-500 sm:table-cell">{n.categoryName}</td>
                <td className="px-3 py-2 text-xs">{n.chapterCount}</td>
                <td className="hidden px-3 py-2 text-xs text-neutral-500 md:table-cell">{formatWordCount(n.wordCount)}</td>
                <td className="px-3 py-2 text-right">
                  <Button size="sm" variant="ghost" className="h-7 px-2" aria-label={`章节管理 ${n.title}`} onClick={() => setChapterNovel(n)}>
                    <BookOpen className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm" variant="ghost" className="h-7 px-2" aria-label={`编辑小说 ${n.title}`}
                    onClick={() => setForm({ id: n.id, title: n.title, author: n.author, description: n.description, categoryId: n.categoryId, status: n.status, isFeatured: n.isFeatured, isHot: n.isHot })}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-red-500 hover:text-red-600" aria-label={`删除小说 ${n.title}`} onClick={() => remove(n)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
            {data?.list.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-sm text-neutral-400">
                  暂无数据
                  {page > 1 && (
                    <Button size="sm" variant="outline" className="ml-3" onClick={() => setPage(1)}>
                      返回第一页
                    </Button>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {data && data.totalPages > 1 && (
        <div className="mt-3 flex items-center justify-center gap-2 text-sm">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button>
          <span className="text-xs text-neutral-500">{page} / {data.totalPages}</span>
          <Button size="sm" variant="outline" disabled={page >= data.totalPages} onClick={() => setPage(page + 1)}>下一页</Button>
        </div>
      )}

      {form && (
        <Modal
          label={form.id ? '编辑小说' : '新增小说'}
          onClose={() => setForm(null)}
          panel="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-5 shadow-xl"
        >
          <h3 className="mb-4 text-base font-semibold">{form.id ? '编辑小说' : '新增小说'}</h3>
          <div className="space-y-3">
            <Field label="书名"><Input autoFocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
            <Field label="作者"><Input value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} /></Field>
            <Field label="分类">
              <select className={selectCls} value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: Number(e.target.value) })}>
                <option value={0}>请选择…</option>
                {categories?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="状态">
              <select className={selectCls} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as 'serial' | 'finished' })}>
                <option value="serial">连载中</option>
                <option value="finished">已完本</option>
              </select>
            </Field>
            <Field label="简介"><Textarea rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
            <div className="flex gap-6">
              <label className="flex items-center gap-2 text-sm"><Switch checked={form.isFeatured} onCheckedChange={(v) => setForm({ ...form, isFeatured: v })} />推荐</label>
              <label className="flex items-center gap-2 text-sm"><Switch checked={form.isHot} onCheckedChange={(v) => setForm({ ...form, isHot: v })} />热门</label>
            </div>
          </div>
          <DialogActions className="mt-5 flex justify-end gap-2" busy={saving} onCancel={() => setForm(null)} onSave={save} />
        </Modal>
      )}

      {chapterNovel && <ChaptersDialog novel={chapterNovel} onClose={() => setChapterNovel(null)} />}
    </div>
  )
}

// ==================== 章节管理 ====================

function ChaptersDialog({ novel, onClose }: { novel: NovelListItem; onClose: () => void }) {
  const qc = useQueryClient()
  const { data: chapters, isLoading, isError, refetch } = useChapters(novel.id)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [editing, setEditing] = useState<{ id: number; title: string; content: string } | null>(null)
  const [adding, setAdding] = useState(false)
  const [saving, setSaving] = useState(false)

  useDialogEscape(onClose)
  // 编辑层嵌套在章节管理层之上：capture 监听优先触发，Esc 只关闭编辑层
  useDialogEscape(() => setEditing(null), editing !== null, true)

  const add = () => {
    if (!title.trim()) return toast.error('标题不能为空')
    return runBusy(setAdding, true, false, '添加失败', async () => {
      await api('/api/chapters', { method: 'POST', body: JSON.stringify({ novelId: novel.id, title, content }) })
      toast.success('章节已添加')
      setTitle(''); setContent('')
      await invalidate(qc, qk.chapters(novel.id), ['novels'], ['novel'], qk.home)
    })
  }

  const saveEdit = () => {
    if (!editing) return
    if (!editing.title.trim()) return toast.error('标题不能为空')
    return runBusy(setSaving, true, false, '保存失败', async () => {
      await api(`/api/chapters/${editing.id}`, { method: 'PUT', body: JSON.stringify({ title: editing.title, content: editing.content }) })
      toast.success('已保存')
      setEditing(null)
      // novels/home 也失效：列表与首页展示的书级字数随章节正文变化（原遗漏导致 30s 内展示旧字数）
      await invalidate(qc, qk.chapters(novel.id), ['chapter'], ['novel'], ['novels'], qk.home)
    })
  }

  const remove = async (id: number) => {
    if (!confirm('确认删除该章节？')) return
    try {
      await api(`/api/chapters/${id}`, { method: 'DELETE' })
      toast.success('已删除')
      await invalidate(qc, qk.chapters(novel.id), ['novels'], ['novel'], ['chapter'])
    } catch (e) {
      toast.error(errMsg(e, '删除失败'))
    }
  }

  return (
    <Modal
      label={`章节管理 ${novel.title}`}
      onClose={onClose}
      panel="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-white shadow-xl"
      below={editing && (
        <Modal
          top
          label="编辑章节"
          onClose={() => setEditing(null)}
          panel="flex max-h-[85vh] w-full max-w-xl flex-col rounded-lg bg-white p-5 shadow-xl"
        >
          <h4 className="mb-3 text-sm font-semibold">编辑章节</h4>
          <Input autoFocus value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} className="mb-2" />
          <Textarea rows={12} value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} className="flex-1" />
          <DialogActions className="mt-3 flex justify-end gap-2" busy={saving} onCancel={() => setEditing(null)} onSave={saveEdit} />
        </Modal>
      )}
    >
      <div className="border-b px-5 py-4">
        <h3 className="text-base font-semibold">章节管理 · {novel.title}</h3>
        <p className="mt-0.5 text-xs text-neutral-500">共 {chapters?.length ?? novel.chapterCount} 章</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mb-4 space-y-2 rounded-lg border bg-neutral-50 p-3">
          <p className="text-xs font-medium text-neutral-600">新增章节</p>
          <Input placeholder="章节标题" value={title} onChange={(e) => setTitle(e.target.value)} className="h-8" />
          <Textarea placeholder="正文（可留空，稍后编辑）" rows={3} value={content} onChange={(e) => setContent(e.target.value)} />
          <Button size="sm" onClick={add} disabled={adding}>{adding ? '添加中…' : <><Plus className="mr-1 h-3.5 w-3.5" />添加</>}</Button>
        </div>
        {isLoading && <p className="py-6 text-center text-sm text-neutral-400">加载中…</p>}
        {isError && (
          <p className="flex items-center justify-center gap-2 py-6 text-center text-sm text-neutral-400">
            章节加载失败
            <Button size="sm" variant="outline" onClick={() => refetch()}>重试</Button>
          </p>
        )}
        {!isLoading && !isError && chapters?.length === 0 && (
          <p className="py-6 text-center text-sm text-neutral-400">暂无章节，可在上方添加</p>
        )}
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {chapters?.map((c) => (
            <div key={c.id} className="flex items-center gap-2 rounded border px-3 py-1.5 text-sm">
              <span className="w-10 shrink-0 text-xs text-neutral-400">{c.idx}</span>
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
              <span className="shrink-0 text-xs text-neutral-400">{formatWordCount(c.wordCount)}字</span>
              <Button size="sm" variant="ghost" className="h-6 px-1.5" aria-label={`编辑章节 ${c.title}`} onClick={async () => {
                try {
                  const detail = await api<{ title: string; content: string }>(`/api/chapters/${c.id}`)
                  setEditing({ id: c.id, title: detail.title, content: detail.content })
                } catch (e) {
                  toast.error(errMsg(e, '加载章节失败'))
                }
              }}>
                <Pencil className="h-3 w-3" />
              </Button>
              <Button size="sm" variant="ghost" className="h-6 px-1.5 text-red-500" aria-label={`删除章节 ${c.title}`} onClick={() => remove(c.id)}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      </div>
      <div className="flex justify-end border-t px-5 py-3">
        <Button variant="outline" onClick={onClose}>关闭</Button>
      </div>

      {/* 编辑层为面板外的兄弟节点（保持原 DOM 层级：其遮罩点击事件冒泡至外层遮罩） */}
    </Modal>
  )
}

// ==================== 分类管理 ====================

export function CategoriesTab() {
  const qc = useQueryClient()
  const { data: categories } = useQuery({ queryKey: qk.categories, queryFn: () => api<CategoryDto[]>('/api/categories') })
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null)
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState(false)

  useDialogEscape(() => setEditing(null), editing !== null)

  const refresh = async () => { await qc.invalidateQueries({ queryKey: qk.categories }); await qc.invalidateQueries({ queryKey: qk.home }) }

  const add = () => {
    if (adding) return
    if (!name.trim()) return toast.error('分类名不能为空')
    return runBusy(setAdding, true, false, '添加失败', async () => {
      await api('/api/categories', { method: 'POST', body: JSON.stringify({ name }) })
      setName(''); await refresh(); toast.success('已添加')
    })
  }

  const saveRename = () => {
    if (!editing) return
    if (!editing.name.trim()) return toast.error('分类名不能为空')
    return runBusy(setRenaming, true, false, '保存失败', async () => {
      await api(`/api/categories/${editing.id}`, { method: 'PUT', body: JSON.stringify({ name: editing.name }) })
      setEditing(null); await refresh(); toast.success('已保存')
    })
  }

  return (
    <div>
      <div className="mb-4 flex gap-2">
        <Input placeholder="新分类名称" value={name} onChange={(e) => setName(e.target.value)} className="h-9 max-w-56" onKeyDown={(e) => e.key === 'Enter' && add()} />
        <Button size="sm" onClick={add} disabled={adding}><Plus className="mr-1 h-3.5 w-3.5" />{adding ? '添加中…' : '添加'}</Button>
      </div>
      {categories === undefined && <p className="py-6 text-center text-sm text-neutral-400">分类加载中…</p>}
      <div className="space-y-1">
        {categories?.map((c) => (
          <div key={c.id} className="flex items-center gap-2 rounded border px-3 py-2 text-sm">
            <Layers className="h-3.5 w-3.5 text-neutral-400" />
            <span className="flex-1">{c.name}</span>
            <span className="text-xs text-neutral-400">{c.novelCount} 本</span>
            <Button size="sm" variant="ghost" className="h-6 px-1.5" aria-label={`重命名分类 ${c.name}`} onClick={() => setEditing({ id: c.id, name: c.name })}>
              <Pencil className="h-3 w-3" />
            </Button>
            <Button size="sm" variant="ghost" className="h-6 px-1.5 text-red-500" aria-label={`删除分类 ${c.name}`} onClick={async () => {
              if (!confirm(`确认删除分类「${c.name}」？`)) return
              try { await api(`/api/categories/${c.id}`, { method: 'DELETE' }); await refresh(); toast.success('已删除') }
              catch (e) { toast.error(errMsg(e, '删除失败')) }
            }}>
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        ))}
      </div>

      {editing && (
        <Modal
          label="重命名分类"
          onClose={() => setEditing(null)}
          panel="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl"
        >
          <h4 className="mb-3 text-sm font-semibold">重命名分类</h4>
          <Input
            autoFocus
            value={editing.name}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') saveRename() }}
            className="mb-3"
          />
          <DialogActions className="flex justify-end gap-2" busy={renaming} onCancel={() => setEditing(null)} onSave={saveRename} />
        </Modal>
      )}
    </div>
  )
}

// ==================== SEO 设置 ====================

const SEO_FIELDS: { key: keyof SeoConfig; label: string; hint?: string; textarea?: boolean }[] = [
  { key: 'homeTitle', label: '首页 T 标题' },
  { key: 'homeDescription', label: '首页 D 描述', textarea: true },
  { key: 'homeKeywords', label: '首页 K 关键词' },
  { key: 'categoryTitle', label: '分类页标题', hint: '变量 {categoryName} {page}' },
  { key: 'categoryDescription', label: '分类页描述', textarea: true },
  { key: 'bookTitle', label: '书籍页标题', hint: '变量 {novelTitle} {author} {categoryName}' },
  { key: 'bookDescription', label: '书籍页描述', textarea: true },
  { key: 'bookKeywords', label: '书籍页关键词' },
  { key: 'tocTitle', label: '目录页标题' },
  { key: 'tocDescription', label: '目录页描述', textarea: true },
  { key: 'chapterTitle', label: '章节页标题', hint: '变量 {chapterTitle} {novelTitle} {idx}' },
  { key: 'chapterDescription', label: '章节页描述', textarea: true },
  { key: 'chapterKeywords', label: '章节页关键词' },
  { key: 'searchTitle', label: '搜索页标题', hint: '变量 {query}' },
  { key: 'searchDescription', label: '搜索页描述', hint: '变量 {query}', textarea: true },
  { key: 'pseoTitle', label: 'PSEO 标题', hint: '变量 {keyword} {count}' },
  { key: 'pseoDescription', label: 'PSEO 描述', textarea: true },
  { key: 'pseoKeywords', label: 'PSEO 关键词', hint: '变量 {keyword}' },
]

export function SeoTab() {
  const { data: settings } = useSettings()
  const qc = useQueryClient()
  const [overrides, setOverrides] = useState<Partial<SeoConfig>>({})
  const [saving, setSaving] = useState(false)
  // 服务端配置与本地覆盖合并：无需 effect 同步
  const form: Partial<SeoConfig> = { ...(settings?.seo ?? {}), ...overrides }
  const setForm = (patch: Partial<SeoConfig>) => setOverrides((o) => ({ ...o, ...patch }))

  const save = () =>
    runBusy(setSaving, true, false, '保存失败', async () => {
      await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ seo: form }) })
      await qc.invalidateQueries({ queryKey: qk.settings })
      toast.success('SEO 配置已保存，前台即刻生效')
    })

  return (
    <div>
      <p className="mb-4 text-xs text-neutral-500">
        自动 TDK 引擎：前台所有页面（首页/分类/书籍/目录/章节/搜索/PSEO）按以下模板自动生成 Title/Description/Keywords，支持变量占位。
      </p>
      <div className="space-y-3">
        {SEO_FIELDS.map((f) => (
          <Field key={String(f.key)} label={f.label + (f.hint ? `（${f.hint}）` : '')}>
            {f.textarea ? (
              <Textarea rows={2} value={String(form[f.key] ?? '')} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
            ) : (
              <Input value={String(form[f.key] ?? '')} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} className="h-8 text-sm" />
            )}
          </Field>
        ))}
        <label className="flex items-center gap-2 rounded border p-3 text-sm">
          <Switch checked={!!form.autoFromContent} onCheckedChange={(v) => setForm({ ...form, autoFromContent: v })} />
          章节页自动从正文提取补充关键词（auto keywords）
        </label>
      </div>
      <div className="sticky bottom-0 mt-4 flex justify-end gap-2 border-t bg-white py-3">
        <Button onClick={save} disabled={saving}>{saving ? '保存中…' : '保存 SEO 配置'}</Button>
      </div>
    </div>
  )
}

// ==================== PSEO 管理（设置 + multi-search-engine 下拉词） ====================

interface PseoRow { id: number; keyword: string; source: string; status: string; updatedAt: string }
interface EngineStat { engine: string; ok: boolean; count: number; error?: string }
interface PseoConfigDto {
  sources: string[] // 启用的搜索引擎
  seeds: string[] // 种子关键词
  perSeedLimit: number
  maxKeywords: number
  expand: boolean
  autoGenerate: boolean
}
interface BatchResp {
  added: number
  generated: number
  level2Seeds: number
  level2Words: number
  report: { seed: string; level: 1 | 2; engines: EngineStat[]; words: number }[]
}

const PSEO_ENGINES: { id: string; label: string }[] = [
  { id: 'baidu', label: '百度' },
  { id: 'bing', label: '必应' },
  { id: 'duckduckgo', label: 'DuckDuckGo' },
  { id: 'sogou', label: '搜狗' },
  { id: 'so360', label: '360搜索' },
]
const EMPTY_PSEO_CFG: PseoConfigDto = {
  sources: PSEO_ENGINES.map((e) => e.id),
  seeds: [],
  perSeedLimit: 12,
  maxKeywords: 200,
  expand: false,
  autoGenerate: true,
}
const engineLabel = (id: string) => PSEO_ENGINES.find((e) => e.id === id)?.label ?? id

export function PseoTab() {
  const qc = useQueryClient()
  const navigate = useAppStore((s) => s.navigate)
  const { data: config } = useQuery({ queryKey: ['pseo-config'], queryFn: () => api<PseoConfigDto>('/api/pseo/config') })
  const { data: rows } = useQuery({ queryKey: ['pseo-keywords'], queryFn: () => api<PseoRow[]>('/api/pseo') })

  // 设置草稿：overrides 合并模式（与 SeoTab 一致）；seeds 走独立文本草稿，避免逐键拆行打断输入
  const [overrides, setOverrides] = useState<Partial<PseoConfigDto>>({})
  const [seedsDraft, setSeedsDraft] = useState<string | null>(null)
  const form: PseoConfigDto = { ...(config ?? EMPTY_PSEO_CFG), ...overrides }
  const seedsText = seedsDraft ?? (config?.seeds ?? []).join('\n')
  const setForm = (patch: Partial<PseoConfigDto>) => setOverrides((o) => ({ ...o, ...patch }))
  // 当前完整配置（含未保存修改；seeds 按行拆分）
  const currentConfig = (): PseoConfigDto => ({
    ...form,
    seeds: seedsText.split('\n').map((s) => s.trim()).filter(Boolean),
  })
  const clearDrafts = () => {
    setOverrides({})
    setSeedsDraft(null)
  }

  const [savingCfg, setSavingCfg] = useState(false)
  const [preview, setPreview] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [running, setRunning] = useState(false)
  const [batchReport, setBatchReport] = useState('')
  const [kw, setKw] = useState('')
  const [busy, setBusy] = useState(false)
  // 引擎全不选守卫：服务端 sanitizePseoConfig 会把空 sources 回退为全部引擎（语义误导），
  // 故在前端禁用全部执行入口，避免「以为跑 0 个引擎实际跑全量」
  const noEngines = form.sources.length === 0

  const saveConfig = () =>
    runBusy(setSavingCfg, true, false, '保存失败', async () => {
      await api('/api/pseo/config', { method: 'PATCH', body: JSON.stringify({ config: currentConfig() }) })
      await qc.invalidateQueries({ queryKey: ['pseo-config'] })
      clearDrafts()
      toast.success('PSEO 设置已保存')
    })

  // 试取预览：只调 suggest 接口看下拉词，不入库（验证引擎连通性/种子质量）
  const runPreview = () => {
    const kw0 = currentConfig().seeds[0]
    if (!kw0) return toast.error('请先在种子关键词中填写至少一个词')
    return runBusy(setPreviewing, true, false, '试取失败', async () => {
      setPreview('')
      const res = await api<{ results: EngineStat[]; words: { word: string; engine: string }[] }>(
        '/api/pseo/suggest',
        { method: 'POST', body: JSON.stringify({ keyword: kw0, sources: form.sources }) },
      )
      const lines = res.results.map((r) => `${engineLabel(r.engine)}: ${r.ok ? `+${r.count} 词` : `失败${r.error ? `（${r.error}）` : ''}`}`)
      setPreview(`试取「${kw0}」\n${lines.join('\n')}\n下拉词：${res.words.map((w) => w.word).join(' / ') || '（无）'}`)
    })
  }

  // 批量应用：携带当前配置（先持久化再执行），种子 × 引擎批量获取下拉词入库
  const runBatch = () => {
    if (currentConfig().seeds.length === 0) return toast.error('请先在 PSEO 设置中填写种子关键词')
    return runBusy(setRunning, true, false, '批量获取失败', async () => {
      setBatchReport('')
      const res = await api<BatchResp>('/api/pseo/batch', { method: 'POST', body: JSON.stringify({ config: currentConfig() }) })
      const lines = res.report.map((r) => {
        const eng = r.engines
          .map((e) => `${engineLabel(e.engine)} ${e.ok ? `+${e.count}` : `失败${e.error ? `（${e.error}）` : ''}`}`)
          .join(' · ')
        return `${r.level === 2 ? '└ 二级' : '「'}${r.seed}${r.level === 2 ? '' : '」'} ${eng} → ${r.words} 词`
      })
      const head = `新增 ${res.added} 个关键词${res.generated ? `，生成 ${res.generated} 个聚合页` : ''}${
        res.level2Words ? `；二级挖掘 ${res.level2Seeds} 词 → +${res.level2Words} 词` : ''
      }`
      setBatchReport([head, ...lines].join('\n'))
      await invalidate(qc, ['pseo-keywords'], ['pseo-config'])
      clearDrafts()
      toast.success(`批量获取完成：新增 ${res.added}`)
    })
  }

  const addKw = () => {
    if (busy) return // Enter 键路径绕过了按钮 disabled，这里补防重复提交
    if (!kw.trim()) return toast.error('请输入关键词')
    return runBusy(setBusy, true, false, '添加失败', async () => {
      const res = await api<{ added: number }>('/api/pseo', { method: 'POST', body: JSON.stringify({ keywords: [kw.trim()] }) })
      setKw('')
      await qc.invalidateQueries({ queryKey: ['pseo-keywords'] })
      toast.success(res.added ? '关键词已添加' : '关键词已存在')
    })
  }

  // 重新生成聚合页：TDK 模板修改后，对 pending/重置过的关键词重跑（不重新抓下拉词）
  const regen = () =>
    runBusy(setBusy, true, false, '生成失败', async () => {
      const res = await api<{ generated: number }>('/api/pseo/generate', { method: 'POST', body: JSON.stringify({ useSuggest: false, limit: 50 }) })
      await qc.invalidateQueries({ queryKey: ['pseo-keywords'] })
      toast.success(`已生成 ${res.generated} 个聚合页`)
    })

  return (
    <div className="space-y-4">
      <section className="rounded-lg border p-4">
        <h4 className="mb-1 text-sm font-semibold">PSEO 设置 · multi-search-engine 下拉词</h4>
        <p className="mb-3 text-[11px] text-neutral-400">
          种子关键词 × 搜索引擎 suggest 接口批量获取下拉词入库；配置持久化保存，可反复一键应用。
        </p>
        <div className="space-y-3">
          <div>
            <p className="mb-1 text-xs font-medium text-neutral-600">搜索引擎</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {PSEO_ENGINES.map((e) => (
                <label key={e.id} className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={form.sources.includes(e.id)}
                    onChange={(ev) =>
                      setForm({ sources: ev.target.checked ? [...form.sources, e.id] : form.sources.filter((x) => x !== e.id) })
                    }
                  />{e.label}
                </label>
              ))}
            </div>
            {noEngines && <p className="mt-1 text-[11px] text-red-500">至少选择一个搜索引擎</p>}
          </div>
          <Field label="种子关键词（每行一个，最多 20 个）">
            <Textarea rows={3} value={seedsText} onChange={(e) => setSeedsDraft(e.target.value)} placeholder={'玄幻\n都市重生\n修仙'} />
          </Field>
          <div className="flex flex-wrap gap-4">
            <Field label="每种子保留词数（3-20）">
              <Input
                type="number" min={3} max={20} value={String(form.perSeedLimit)}
                onChange={(e) => setForm({ perSeedLimit: Number(e.target.value) || 12 })}
                className="h-8 w-24 text-sm"
              />
            </Field>
            <Field label="单次入库上限（10-500）">
              <Input
                type="number" min={10} max={500} value={String(form.maxKeywords)}
                onChange={(e) => setForm({ maxKeywords: Number(e.target.value) || 200 })}
                className="h-8 w-24 text-sm"
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={form.autoGenerate} onCheckedChange={(v) => setForm({ autoGenerate: v })} />
            获取后自动生成 PSEO 聚合页
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={form.expand} onCheckedChange={(v) => setForm({ expand: v })} />
            二级挖掘（以下拉词为新种子再获取一轮）
          </label>
        </div>
        <div className="mt-3 flex gap-2">
          <Button size="sm" variant="outline" onClick={saveConfig} disabled={savingCfg || running || noEngines}>
            {savingCfg ? '保存中…' : '保存设置'}
          </Button>
          <Button size="sm" variant="outline" onClick={runPreview} disabled={previewing || running || noEngines}>
            {previewing ? '试取中…' : '试取预览（首个种子）'}
          </Button>
        </div>
        {preview && <pre className="mt-2 whitespace-pre-wrap rounded bg-neutral-100 p-2 text-[11px] text-neutral-600">{preview}</pre>}
      </section>

      <section className="rounded-lg border p-4">
        <h4 className="mb-1 text-sm font-semibold">应用设置 · 批量获取下拉词</h4>
        <p className="mb-3 text-[11px] text-neutral-400">
          按上方当前配置（含未保存的修改，执行前自动持久化）运行；跨种子/跨引擎自动去重，失败引擎如实报告。
        </p>
        <Button size="sm" onClick={runBatch} disabled={running || savingCfg || noEngines}>
          {running ? '获取中…（种子较多约需 1-2 分钟）' : '开始批量获取'}
        </Button>
        {batchReport && <pre className="mt-2 whitespace-pre-wrap rounded bg-neutral-100 p-2 text-[11px] text-neutral-600">{batchReport}</pre>}
      </section>

      <section className="rounded-lg border p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-semibold">关键词库（{rows?.length ?? 0}）</h4>
          <div className="flex gap-2">
            <Input
              value={kw} onChange={(e) => setKw(e.target.value)}
              placeholder="手工添加关键词" className="h-7 w-40 text-xs"
              onKeyDown={(e) => { if (e.key === 'Enter') addKw() }}
            />
            <Button size="sm" variant="outline" className="h-7" onClick={addKw} disabled={busy}><Plus className="h-3 w-3" /></Button>
            <Button size="sm" variant="outline" className="h-7" onClick={regen} disabled={busy}>重新生成聚合页</Button>
          </div>
        </div>
        <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
          {rows?.map((r) => (
            <div key={r.id} className="flex items-center gap-2 rounded border px-3 py-1.5 text-xs">
              <span className="min-w-0 flex-1 truncate font-medium">{r.keyword}</span>
              <Badge variant="outline" className="shrink-0">{r.source}</Badge>
              <Badge variant={r.status === 'generated' ? 'default' : 'secondary'} className="shrink-0">{r.status}</Badge>
              <span className="shrink-0 text-neutral-400">{timeAgo(r.updatedAt)}</span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 shrink-0 px-1.5"
                onClick={() => {
                  // 后台是 hash 路由 #/admin：仅 navigate() 改 store 不会切换渲染，
                  // 需同时清掉 hash 退回前台，ThemeRenderer 才会渲染该 PSEO 聚合页
                  navigate({ name: 'pseo', keyword: r.keyword })
                  window.location.hash = ''
                }}
              >
                预览
              </Button>
              <Button size="sm" variant="ghost" className="h-6 shrink-0 px-1.5 text-red-500" aria-label={`删除关键词 ${r.keyword}`} onClick={async () => {
                try {
                  await api(`/api/pseo?id=${r.id}`, { method: 'DELETE' })
                  await qc.invalidateQueries({ queryKey: ['pseo-keywords'] })
                  toast.success('关键词已删除')
                } catch (e) {
                  toast.error(errMsg(e, '删除失败'))
                }
              }}><Trash2 className="h-3 w-3" /></Button>
            </div>
          ))}
          {rows?.length === 0 && <p className="py-3 text-center text-xs text-neutral-400">暂无关键词</p>}
        </div>
      </section>
    </div>
  )
}

// ==================== 站点设置 ====================

export function SettingsTab() {
  const { data: settings } = useSettings()
  const qc = useQueryClient()
  const [siteNameDraft, setSiteNameDraft] = useState<string | null>(null)
  const [noticeDraft, setNoticeDraft] = useState<string | null>(null)
  // 页脚草稿（null = 未动过，跟随服务端值；links 为受控数组）
  const [footerTextDraft, setFooterTextDraft] = useState<string | null>(null)
  const [footerExtraDraft, setFooterExtraDraft] = useState<string | null>(null)
  const [footerLinksDraft, setFooterLinksDraft] = useState<{ label: string; href: string }[] | null>(null)
  const [saving, setSaving] = useState(false)

  const siteName = siteNameDraft ?? settings?.siteName ?? ''
  const notice = noticeDraft ?? settings?.notice ?? ''
  const footerText = footerTextDraft ?? settings?.footer?.text ?? ''
  const footerExtra = footerExtraDraft ?? settings?.footer?.extra ?? ''
  const footerLinks = footerLinksDraft ?? settings?.footer?.links ?? []
  const setSiteName = setSiteNameDraft
  const setNotice = setNoticeDraft

  const footerDirty =
    footerTextDraft !== null || footerExtraDraft !== null || footerLinksDraft !== null

  const resetFooter = () => {
    setFooterTextDraft(null)
    setFooterExtraDraft(null)
    setFooterLinksDraft(null)
  }

  const save = () => {
    // 站点名是全站页头/TDK 的根变量：留空时服务端会静默忽略导致“已保存”假象，这里前置拦截
    if (!siteName.trim()) return toast.error('站点名称不能为空')
    return runBusy(setSaving, true, false, '保存失败', async () => {
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          siteName,
          notice,
          // 仅当页脚被编辑过才提交，避免未触碰的表单覆盖他人保存的页脚配置
          ...(footerDirty ? { footer: { text: footerText, extra: footerExtra, links: footerLinks } } : {}),
        }),
      })
      await qc.invalidateQueries({ queryKey: qk.settings })
      toast.success('站点设置已保存')
    })
  }

  return (
    <div className="space-y-4">
      <Field label="站点名称（全站页头/页脚/TDK 中使用）">
        <Input value={siteName} onChange={(e) => setSiteName(e.target.value)} />
      </Field>
      <Field label="站点公告（部分主题在首页展示）">
        <Textarea rows={3} value={notice} onChange={(e) => setNotice(e.target.value)} />
      </Field>

      {/* 页面底部（页脚）编辑：text/extra 留空 = 主题默认文案；links 追加为页脚链接 */}
      <fieldset className="space-y-3 rounded-md border p-3">
        <legend className="px-1 text-xs font-semibold text-neutral-700">页面底部（页脚）</legend>
        <Field label="主文案行（版权行，留空使用主题默认）">
          <Input
            value={footerText}
            onChange={(e) => setFooterTextDraft(e.target.value)}
            placeholder={`如：Copyright © ${new Date().getFullYear()} ${siteName || '青阅文学'}`}
          />
        </Field>
        <Field label="副文案行（免责声明等，留空使用主题默认）">
          <Textarea
            rows={2}
            value={footerExtra}
            onChange={(e) => setFooterExtraDraft(e.target.value)}
            placeholder="如：本站书籍均来自网络收集，版权归原作者所有。"
          />
        </Field>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-neutral-500">自定义链接（友链/备案号等，最多 10 条）</span>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={footerLinks.length >= 10}
              onClick={() => setFooterLinksDraft([...footerLinks, { label: '', href: '' }])}
            >
              <Plus className="mr-1 h-3 w-3" />添加链接
            </Button>
          </div>
          {footerLinks.map((lk, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input
                value={lk.label}
                onChange={(e) => {
                  const next = [...footerLinks]
                  next[i] = { ...next[i], label: e.target.value }
                  setFooterLinksDraft(next)
                }}
                placeholder="名称"
                className="h-8 w-24 shrink-0 text-xs sm:w-28"
                aria-label={`链接 ${i + 1} 名称`}
              />
              <Input
                value={lk.href}
                onChange={(e) => {
                  const next = [...footerLinks]
                  next[i] = { ...next[i], href: e.target.value }
                  setFooterLinksDraft(next)
                }}
                placeholder="地址（https:// 或 / 开头）"
                className="h-8 min-w-0 flex-1 text-xs"
                aria-label={`链接 ${i + 1} 地址`}
              />
              <Button
                size="sm"
                variant="ghost"
                className="h-8 w-8 shrink-0 px-0 text-red-500"
                aria-label={`删除链接 ${i + 1}`}
                onClick={() => setFooterLinksDraft(footerLinks.filter((_, j) => j !== i))}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
          {footerLinks.length === 0 && (
            <p className="text-[11px] text-neutral-400">暂无自定义链接，主题页脚仅显示导航与文案行。</p>
          )}
        </div>
        {footerDirty && (
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" className="h-7" onClick={resetFooter}>
              撤销页脚修改
            </Button>
          </div>
        )}
      </fieldset>

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
      </div>
    </div>
  )
}
