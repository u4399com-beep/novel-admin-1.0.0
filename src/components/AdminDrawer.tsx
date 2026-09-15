'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Settings, RefreshCw, Trash2, Pencil, Plus, BookOpen, Layers, SearchCode, Sparkles } from 'lucide-react'
import { THEME_LIST } from '@/themes/registry'
import { useAppStore } from '@/lib/store'
import { useChapters, useNovels, useSettings, qk } from '@/hooks/use-novel-data'
import type { CategoryDto, NovelListItem, ScrapeRuleDto, SeoConfig } from '@/lib/types'
import { formatWordCount, timeAgo } from '@/lib/format'
import { QueryClient, useQuery, useQueryClient } from '@tanstack/react-query'

type Json = Record<string, unknown>

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `请求失败(${res.status})`)
  return data as T
}

// ==================== 入口 ====================

export function AdminDrawer() {
  const [open, setOpen] = useState(false)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          aria-label="打开管理面板"
          className="fixed bottom-5 right-5 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-neutral-900 text-white shadow-lg transition hover:scale-105 hover:bg-neutral-700"
        >
          <Settings className="h-5 w-5" />
        </button>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4" /> 站点管理控制台
          </SheetTitle>
        </SheetHeader>
        {open && <AdminTabs />}
      </SheetContent>
    </Sheet>
  )
}

// ==================== Tabs 容器 ====================

function AdminTabs() {
  return (
    <Tabs defaultValue="themes" className="flex min-h-0 flex-1 flex-col gap-0">
      <TabsList className="flex w-full flex-wrap gap-1 rounded-none border-b bg-neutral-50 px-2 py-2 justify-start h-auto">
        <TabsTrigger value="themes">主题</TabsTrigger>
        <TabsTrigger value="novels">书籍</TabsTrigger>
        <TabsTrigger value="categories">分类</TabsTrigger>
        <TabsTrigger value="seo">SEO</TabsTrigger>
        <TabsTrigger value="scraper">采集</TabsTrigger>
        <TabsTrigger value="pseo">PSEO</TabsTrigger>
        <TabsTrigger value="settings">设置</TabsTrigger>
      </TabsList>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4">
          <TabsContent value="themes" className="mt-0"><ThemesTab /></TabsContent>
          <TabsContent value="novels" className="mt-0"><NovelsTab /></TabsContent>
          <TabsContent value="categories" className="mt-0"><CategoriesTab /></TabsContent>
          <TabsContent value="seo" className="mt-0"><SeoTab /></TabsContent>
          <TabsContent value="scraper" className="mt-0"><ScraperTab /></TabsContent>
          <TabsContent value="pseo" className="mt-0"><PseoTab /></TabsContent>
          <TabsContent value="settings" className="mt-0"><SettingsTab /></TabsContent>
        </div>
      </ScrollArea>
    </Tabs>
  )
}

// ==================== 主题管理 ====================

function ThemesTab() {
  const { data: settings, refetch } = useSettings()
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)

  const activate = async (id: string) => {
    setBusy(id)
    try {
      await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ activeTheme: id }) })
      await qc.invalidateQueries({ queryKey: qk.settings })
      refetch()
      toast.success('主题已切换')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '切换失败')
    } finally {
      setBusy(null)
    }
  }

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

function NovelsTab() {
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const { data } = useNovels({ q, page, pageSize: 15 })
  const { data: categories } = useQuery({ queryKey: qk.categories, queryFn: () => api<CategoryDto[]>('/api/categories') })
  const qc = useQueryClient()
  const [form, setForm] = useState<NovelForm | null>(null)
  const [chapterNovel, setChapterNovel] = useState<NovelListItem | null>(null)

  const save = async () => {
    if (!form) return
    if (!form.title.trim()) return toast.error('书名不能为空')
    if (!form.categoryId) return toast.error('请选择分类')
    try {
      if (form.id) {
        await api(`/api/novels/${form.id}`, { method: 'PUT', body: JSON.stringify(form) })
        toast.success('已保存')
      } else {
        await api('/api/novels', { method: 'POST', body: JSON.stringify(form) })
        toast.success('已新增')
      }
      setForm(null)
      await qc.invalidateQueries({ queryKey: ['novels'] })
      await qc.invalidateQueries({ queryKey: qk.home })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    }
  }

  const remove = async (n: NovelListItem) => {
    if (!confirm(`确认删除《${n.title}》及其全部章节？此操作不可恢复。`)) return
    try {
      await api(`/api/novels/${n.id}`, { method: 'DELETE' })
      toast.success('已删除')
      await qc.invalidateQueries({ queryKey: ['novels'] })
      await qc.invalidateQueries({ queryKey: qk.home })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败')
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
                  <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setChapterNovel(n)}>
                    <BookOpen className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm" variant="ghost" className="h-7 px-2"
                    onClick={() => setForm({ id: n.id, title: n.title, author: n.author, description: n.description, categoryId: n.categoryId, status: n.status, isFeatured: n.isFeatured, isHot: n.isHot })}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-red-500 hover:text-red-600" onClick={() => remove(n)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
            {data?.list.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-8 text-center text-sm text-neutral-400">暂无数据</td></tr>
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
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => setForm(null)}>
          <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-4 text-base font-semibold">{form.id ? '编辑小说' : '新增小说'}</h3>
            <div className="space-y-3">
              <Field label="书名"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
              <Field label="作者"><Input value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} /></Field>
              <Field label="分类">
                <select
                  className="h-9 w-full rounded-md border border-neutral-200 px-2 text-sm"
                  value={form.categoryId}
                  onChange={(e) => setForm({ ...form, categoryId: Number(e.target.value) })}
                >
                  <option value={0}>请选择…</option>
                  {categories?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
              <Field label="状态">
                <select
                  className="h-9 w-full rounded-md border border-neutral-200 px-2 text-sm"
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value as 'serial' | 'finished' })}
                >
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
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setForm(null)}>取消</Button>
              <Button onClick={save}>保存</Button>
            </div>
          </div>
        </div>
      )}

      {chapterNovel && <ChaptersDialog novel={chapterNovel} onClose={() => setChapterNovel(null)} />}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-neutral-600">{label}</span>
      {children}
    </label>
  )
}

// ==================== 章节管理 ====================

function ChaptersDialog({ novel, onClose }: { novel: NovelListItem; onClose: () => void }) {
  const qc = useQueryClient()
  const { data: chapters, isLoading } = useChapters(novel.id)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [editing, setEditing] = useState<{ id: number; title: string; content: string } | null>(null)

  const add = async () => {
    if (!title.trim()) return toast.error('标题不能为空')
    try {
      await api('/api/chapters', { method: 'POST', body: JSON.stringify({ novelId: novel.id, title, content }) })
      toast.success('章节已添加')
      setTitle(''); setContent('')
      await qc.invalidateQueries({ queryKey: qk.chapters(novel.id) })
      await qc.invalidateQueries({ queryKey: ['novels'] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '添加失败')
    }
  }

  const saveEdit = async () => {
    if (!editing) return
    try {
      await api(`/api/chapters/${editing.id}`, { method: 'PUT', body: JSON.stringify({ title: editing.title, content: editing.content }) })
      toast.success('已保存')
      setEditing(null)
      await qc.invalidateQueries({ queryKey: qk.chapters(novel.id) })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    }
  }

  const remove = async (id: number) => {
    if (!confirm('确认删除该章节？')) return
    try {
      await api(`/api/chapters/${id}`, { method: 'DELETE' })
      toast.success('已删除')
      await qc.invalidateQueries({ queryKey: qk.chapters(novel.id) })
      await qc.invalidateQueries({ queryKey: ['novels'] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败')
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="border-b px-5 py-4">
          <h3 className="text-base font-semibold">章节管理 · {novel.title}</h3>
          <p className="mt-0.5 text-xs text-neutral-500">共 {novel.chapterCount} 章</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="mb-4 space-y-2 rounded-lg border bg-neutral-50 p-3">
            <p className="text-xs font-medium text-neutral-600">新增章节</p>
            <Input placeholder="章节标题" value={title} onChange={(e) => setTitle(e.target.value)} className="h-8" />
            <Textarea placeholder="正文（可留空，稍后编辑）" rows={3} value={content} onChange={(e) => setContent(e.target.value)} />
            <Button size="sm" onClick={add}><Plus className="mr-1 h-3.5 w-3.5" />添加</Button>
          </div>
          {isLoading && <p className="py-6 text-center text-sm text-neutral-400">加载中…</p>}
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {chapters?.map((c) => (
              <div key={c.id} className="flex items-center gap-2 rounded border px-3 py-1.5 text-sm">
                <span className="w-10 shrink-0 text-xs text-neutral-400">{c.idx}</span>
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                <span className="shrink-0 text-xs text-neutral-400">{formatWordCount(c.wordCount)}字</span>
                <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={async () => {
                  const detail = await api<{ title: string; content: string }>(`/api/chapters/${c.id}`)
                  setEditing({ id: c.id, title: detail.title, content: detail.content })
                }}>
                  <Pencil className="h-3 w-3" />
                </Button>
                <Button size="sm" variant="ghost" className="h-6 px-1.5 text-red-500" onClick={() => remove(c.id)}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        </div>
        <div className="flex justify-end border-t px-5 py-3">
          <Button variant="outline" onClick={onClose}>关闭</Button>
        </div>
      </div>

      {editing && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" onClick={() => setEditing(null)}>
          <div className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h4 className="mb-3 text-sm font-semibold">编辑章节</h4>
            <Input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} className="mb-2" />
            <Textarea rows={12} value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} className="flex-1" />
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>取消</Button>
              <Button onClick={saveEdit}>保存</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ==================== 分类管理 ====================

function CategoriesTab() {
  const qc = useQueryClient()
  const { data: categories } = useQuery({ queryKey: qk.categories, queryFn: () => api<CategoryDto[]>('/api/categories') })
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null)

  const refresh = async () => { await qc.invalidateQueries({ queryKey: qk.categories }); await qc.invalidateQueries({ queryKey: qk.home }) }

  const add = async () => {
    if (!name.trim()) return toast.error('分类名不能为空')
    try {
      await api('/api/categories', { method: 'POST', body: JSON.stringify({ name }) })
      setName(''); await refresh(); toast.success('已添加')
    } catch (e) { toast.error(e instanceof Error ? e.message : '添加失败') }
  }

  return (
    <div>
      <div className="mb-4 flex gap-2">
        <Input placeholder="新分类名称" value={name} onChange={(e) => setName(e.target.value)} className="h-9 max-w-56" onKeyDown={(e) => e.key === 'Enter' && add()} />
        <Button size="sm" onClick={add}><Plus className="mr-1 h-3.5 w-3.5" />添加</Button>
      </div>
      <div className="space-y-1">
        {categories?.map((c) => (
          <div key={c.id} className="flex items-center gap-2 rounded border px-3 py-2 text-sm">
            <Layers className="h-3.5 w-3.5 text-neutral-400" />
            <span className="flex-1">{c.name}</span>
            <span className="text-xs text-neutral-400">{c.novelCount} 本</span>
            <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => setEditing({ id: c.id, name: c.name })}>
              <Pencil className="h-3 w-3" />
            </Button>
            <Button size="sm" variant="ghost" className="h-6 px-1.5 text-red-500" onClick={async () => {
              try { await api(`/api/categories/${c.id}`, { method: 'DELETE' }); await refresh(); toast.success('已删除') }
              catch (e) { toast.error(e instanceof Error ? e.message : '删除失败') }
            }}>
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        ))}
      </div>

      {editing && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => setEditing(null)}>
          <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h4 className="mb-3 text-sm font-semibold">重命名分类</h4>
            <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className="mb-3" />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>取消</Button>
              <Button onClick={async () => {
                try {
                  await api(`/api/categories/${editing.id}`, { method: 'PUT', body: JSON.stringify({ name: editing.name }) })
                  setEditing(null); await refresh(); toast.success('已保存')
                } catch (e) { toast.error(e instanceof Error ? e.message : '保存失败') }
              }}>保存</Button>
            </div>
          </div>
        </div>
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
  { key: 'pseoTitle', label: 'PSEO 标题', hint: '变量 {keyword} {count}' },
  { key: 'pseoDescription', label: 'PSEO 描述', textarea: true },
]

function SeoTab() {
  const { data: settings } = useSettings()
  const qc = useQueryClient()
  const [overrides, setOverrides] = useState<Partial<SeoConfig>>({})
  const [saving, setSaving] = useState(false)
  // 服务端配置与本地覆盖合并：无需 effect 同步
  const form: Partial<SeoConfig> = { ...(settings?.seo ?? {}), ...overrides }
  const setForm = (patch: Partial<SeoConfig>) => setOverrides((o) => ({ ...o, ...patch }))

  const save = async () => {
    setSaving(true)
    try {
      await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ seo: form }) })
      await qc.invalidateQueries({ queryKey: qk.settings })
      toast.success('SEO 配置已保存，前台即刻生效')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

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

// ==================== 采集中心 ====================

interface StrategyInfo { name: string; description: string; available: boolean }

function ScraperTab() {
  const qc = useQueryClient()
  const [testUrl, setTestUrl] = useState('https://example.com/')
  const [ruleId, setRuleId] = useState<string>('')
  const [result, setResult] = useState<string>('')
  const [running, setRunning] = useState(false)

  const { data: strategies, isLoading: sLoading } = useQuery({
    queryKey: ['scraper-strategies'],
    queryFn: () => api<{ strategies: StrategyInfo[] }>('/api/scrape?proxy=strategies'),
    refetchInterval: 30_000,
  })
  const { data: rules } = useQuery({ queryKey: ['scrape-rules'], queryFn: () => api<ScrapeRuleDto[]>('/api/scrape-rules') })

  const seed = async () => {
    try {
      await api('/api/scrape-rules', { method: 'PUT', body: JSON.stringify({ seed: true }) })
      await qc.invalidateQueries({ queryKey: ['scrape-rules'] })
      toast.success('内置规则模板已入库')
    } catch (e) { toast.error(e instanceof Error ? e.message : '操作失败') }
  }

  const runTest = async () => {
    const rule = rules?.find((r) => String(r.id) === ruleId)
    setRunning(true)
    setResult('')
    try {
      const res = await api<Json>('/api/scrape?proxy=test', {
        method: 'POST',
        body: JSON.stringify({
          url: testUrl,
          strategy: undefined,
          rule: rule ? { listRule: rule.listRule, bookRule: rule.bookRule, chapterRule: rule.chapterRule } : {},
          charset: rule?.charset,
        }),
      })
      setResult(JSON.stringify(res, null, 2).slice(0, 6000))
    } catch (e) {
      setResult('测试失败：' + (e instanceof Error ? e.message : '未知错误'))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-lg border p-4">
        <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><RefreshCw className="h-3.5 w-3.5" />抓取策略（scraper-service :3030）</h4>
        {sLoading && <p className="text-xs text-neutral-400">检测中…</p>}
        <div className="space-y-1.5">
          {strategies?.strategies.map((s) => (
            <div key={s.name} className="flex items-start gap-2 text-xs">
              <Badge variant={s.available ? 'default' : 'secondary'} className="shrink-0">{s.available ? '可用' : '未启用'}</Badge>
              <span className="font-medium">{s.name}</span>
              <span className="text-neutral-500">{s.description}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-neutral-400">
          合规：默认 ≥1.2s/域名限速、robots 提示、仅公开页面；不含验证码破解/登录伪造。技术选型详见 docs/anti-anti-crawl.md
        </p>
      </section>

      <section className="rounded-lg border p-4">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-semibold">采集规则（{rules?.length ?? 0}）</h4>
          <Button size="sm" variant="outline" onClick={seed}>一键内置站点模板</Button>
        </div>
        <div className="space-y-1">
          {rules?.map((r) => (
            <div key={r.id} className="flex items-center gap-2 rounded border px-3 py-1.5 text-xs">
              <span className="flex-1 truncate font-medium">{r.name}</span>
              <span className="text-neutral-400">{r.siteUrl}</span>
              <Badge variant="outline">{r.charset}</Badge>
              <Button size="sm" variant="ghost" className="h-5 px-1 text-red-500" onClick={async () => {
                await api(`/api/scrape-rules?id=${r.id}`, { method: 'DELETE' })
                qc.invalidateQueries({ queryKey: ['scrape-rules'] })
              }}><Trash2 className="h-3 w-3" /></Button>
            </div>
          ))}
          {rules?.length === 0 && <p className="py-3 text-center text-xs text-neutral-400">暂无规则，点击上方按钮入库模板</p>}
        </div>
      </section>

      <section className="rounded-lg border p-4">
        <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><SearchCode className="h-3.5 w-3.5" />规则测试台</h4>
        <div className="flex flex-wrap gap-2">
          <Input value={testUrl} onChange={(e) => setTestUrl(e.target.value)} placeholder="目标 URL" className="h-8 min-w-56 flex-1" />
          <select value={ruleId} onChange={(e) => setRuleId(e.target.value)} className="h-8 rounded-md border border-neutral-200 px-2 text-xs">
            <option value="">不使用规则（仅基础信息）</option>
            {rules?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <Button size="sm" onClick={runTest} disabled={running}>{running ? '采集中…' : '测试'}</Button>
        </div>
        {result && (
          <pre className="mt-3 max-h-72 overflow-auto rounded bg-neutral-950 p-3 text-[11px] leading-relaxed text-emerald-300">{result}</pre>
        )}
      </section>
    </div>
  )
}

// ==================== PSEO 管理 ====================

interface PseoRow { id: number; keyword: string; source: string; status: string; updatedAt: string }

function PseoTab() {
  const qc = useQueryClient()
  const navigate = useAppStore((s) => s.navigate)
  const { data: rows } = useQuery({ queryKey: ['pseo-keywords'], queryFn: () => api<PseoRow[]>('/api/pseo') })
  const [kw, setKw] = useState('')
  const [engines, setEngines] = useState<string[]>(['baidu', 'bing', 'duckduckgo', 'sogou', 'so360'])
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<string>('')

  const generate = async () => {
    if (!kw.trim()) return toast.error('请输入种子关键词')
    setRunning(true); setReport('')
    try {
      const res = await api<{ added: number; generated: number; suggestions: { engine: string; ok: boolean; count: number; error?: string }[] }>(
        '/api/pseo/generate',
        { method: 'POST', body: JSON.stringify({ keyword: kw.trim(), sources: engines, limit: 30 }) }
      )
      const lines = res.suggestions.map((s) => `${s.engine}: ${s.ok ? `+${s.count} 词` : `失败${s.error ? '（' + s.error + '）' : ''}`}`)
      setReport(`新增 ${res.added} 个关键词，生成 ${res.generated} 个聚合页\n${lines.join('\n')}`)
      await qc.invalidateQueries({ queryKey: ['pseo-keywords'] })
      toast.success(`下拉词获取完成：新增 ${res.added}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '生成失败')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-lg border p-4">
        <h4 className="mb-2 text-sm font-semibold">多搜索引擎下拉词 → PSEO 聚合页</h4>
        <div className="flex flex-wrap gap-2">
          <Input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="种子关键词，如：玄幻" className="h-8 max-w-52" />
          {['baidu', 'bing', 'duckduckgo', 'sogou', 'so360'].map((e) => (
            <label key={e} className="flex items-center gap-1 text-xs">
              <input
                type="checkbox" checked={engines.includes(e)}
                onChange={(ev) => setEngines(ev.target.checked ? [...engines, e] : engines.filter((x) => x !== e))}
              />{e}
            </label>
          ))}
          <Button size="sm" onClick={generate} disabled={running}>{running ? '获取中…' : '获取下拉词并生成'}</Button>
        </div>
        {report && <pre className="mt-2 whitespace-pre-wrap rounded bg-neutral-100 p-2 text-[11px] text-neutral-600">{report}</pre>}
        <p className="mt-2 text-[11px] text-neutral-400">沙箱网络可能限制部分引擎，失败的引擎会如实报告；也可在下方手工添加关键词。</p>
      </section>

      <section className="rounded-lg border p-4">
        <h4 className="mb-2 text-sm font-semibold">关键词库（{rows?.length ?? 0}）</h4>
        <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
          {rows?.map((r) => (
            <div key={r.id} className="flex items-center gap-2 rounded border px-3 py-1.5 text-xs">
              <span className="min-w-0 flex-1 truncate font-medium">{r.keyword}</span>
              <Badge variant="outline" className="shrink-0">{r.source}</Badge>
              <Badge variant={r.status === 'generated' ? 'default' : 'secondary'} className="shrink-0">{r.status}</Badge>
              <span className="shrink-0 text-neutral-400">{timeAgo(r.updatedAt)}</span>
              <Button size="sm" variant="ghost" className="h-5 shrink-0 px-1" onClick={() => navigate({ name: 'pseo', keyword: r.keyword })}>
                预览
              </Button>
              <Button size="sm" variant="ghost" className="h-5 shrink-0 px-1 text-red-500" onClick={async () => {
                await api(`/api/pseo?id=${r.id}`, { method: 'DELETE' })
                qc.invalidateQueries({ queryKey: ['pseo-keywords'] })
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

function SettingsTab() {
  const { data: settings } = useSettings()
  const qc = useQueryClient()
  const [siteNameDraft, setSiteNameDraft] = useState<string | null>(null)
  const [noticeDraft, setNoticeDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const siteName = siteNameDraft ?? settings?.siteName ?? ''
  const notice = noticeDraft ?? settings?.notice ?? ''
  const setSiteName = setSiteNameDraft
  const setNotice = setNoticeDraft

  const save = async () => {
    setSaving(true)
    try {
      await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ siteName, notice }) })
      await qc.invalidateQueries({ queryKey: qk.settings })
      toast.success('站点设置已保存')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <Field label="站点名称（全站页头/页脚/TDK 中使用）">
        <Input value={siteName} onChange={(e) => setSiteName(e.target.value)} />
      </Field>
      <Field label="站点公告（部分主题在首页展示）">
        <Textarea rows={3} value={notice} onChange={(e) => setNotice(e.target.value)} />
      </Field>
      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
      </div>
    </div>
  )
}
