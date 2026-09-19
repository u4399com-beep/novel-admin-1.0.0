'use client'

/**
 * 采集规则区块：规则列表（启停/删除/编辑入口）+ 内置模板入库 + 存量章节清洗。
 * 自 ScrapeCenter.tsx 原样拆分，交互与文案保持不变。
 */

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { BookOpen, ChartLine, Eraser, ListOrdered, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'
import type { ScrapeRuleDto } from '@/lib/types'
import { runBusy } from '../ui-shared'
import { RuleDialog } from './RuleDialog'
import { api, cleanRule, truncate } from './shared'

export function RulesCard({ rules }: { rules: ScrapeRuleDto[] | undefined }) {
  const qc = useQueryClient()
  // undefined=关闭 / null=新建 / 规则对象=编辑
  const [dialogRule, setDialogRule] = useState<ScrapeRuleDto | null | undefined>(undefined)
  // 启停/删除进行中的规则 id（防重复提交）
  const [busyId, setBusyId] = useState<number | null>(null)
  // 内置模板入库进行中（防重复点击；服务端幂等，此处仅避免重复请求与重复 toast）
  const [seeding, setSeeding] = useState(false)
  // 存量章节清洗进行中（防重复点击）
  const [cleaning, setCleaning] = useState(false)
  // 字数审计进行中（防重复点击）
  const [auditing, setAuditing] = useState(false)
  // 目录重排进行中（防重复点击）
  const [resorting, setResorting] = useState(false)

  const refresh = () => qc.invalidateQueries({ queryKey: ['scrape-rules'] })

  const seed = () => {
    if (seeding) return
    return runBusy(setSeeding, true, false, '操作失败', async () => {
      const res = await api<{ added: number }>('/api/scrape-rules', {
        method: 'PUT',
        body: JSON.stringify({ seed: true }),
      })
      await refresh()
      toast.success(`内置模板入库完成：新增 ${res.added} 条`)
    })
  }

  const toggleEnabled = (r: ScrapeRuleDto, enabled: boolean) => {
    if (busyId !== null) return
    return runBusy(setBusyId, r.id, null, '操作失败', async () => {
      await api('/api/scrape-rules', {
        method: 'PUT',
        body: JSON.stringify({
          id: r.id,
          name: r.name,
          siteUrl: r.siteUrl,
          enabled,
          charset: r.charset,
          notes: r.notes,
          listRule: cleanRule(r.listRule),
          bookRule: cleanRule(r.bookRule),
          chapterRule: cleanRule(r.chapterRule),
        }),
      })
      await refresh()
      toast.success(`规则「${r.name}」已${enabled ? '启用' : '停用'}`)
    })
  }

  const remove = (r: ScrapeRuleDto) => {
    if (busyId !== null) return
    if (!confirm(`确认删除规则「${r.name}」？此操作不可恢复。`)) return
    return runBusy(setBusyId, r.id, null, '删除失败', async () => {
      await api(`/api/scrape-rules?id=${r.id}`, { method: 'DELETE' })
      await refresh()
      toast.success('规则已删除')
    })
  }

  /** 存量数据噪声清洗（章节正文+标题+书籍字段）：confirm → dryRun 预览 → 正式清洗 → toast 汇报 */
  const cleanStored = () => {
    if (cleaning) return
    if (
      !confirm(
        '将扫描全部已入库数据：清除章节正文的行首缩进、空行与广告/导航噪声行，解码实体残留（&#091；类），剥除书名/作者/简介的样板文案并重算字数。此操作直接修改数据库，建议先备份。继续？',
      )
    )
      return
    return runBusy(setCleaning, true, false, '清洗失败', async () => {
      const dry = await api<{
        checked: number
        toClean: number
        booksChecked: number
        booksToFix: number
        chapterTitlesToFix: number
      }>('/api/chapters/clean-all?dryRun=1')
      if (dry.toClean === 0 && dry.booksToFix === 0 && dry.chapterTitlesToFix === 0) {
        toast.success(
          `预览完成：检查 ${dry.checked} 章 / ${dry.booksChecked} 本书，无需要清洗的数据`,
        )
        return
      }
      const res = await api<{
        checked: number
        cleaned: number
        booksFixed: number
        booksSkipped: number
        chapterTitlesFixed: number
      }>('/api/chapters/clean-all', {
        method: 'POST',
      })
      toast.success(
        `清洗完成：正文 ${res.cleaned} 章、标题 ${res.chapterTitlesFixed} 章、书籍字段 ${res.booksFixed} 本` +
          (res.booksSkipped > 0 ? `（${res.booksSkipped} 项变更因同名同作者冲突被跳过）` : ''),
      )
      // 章节正文/书籍字段已变化，站点侧缓存全部失效
      void qc.invalidateQueries()
    })
  }

  /** 全站字数审计：GET 预览不符清单 → 有差异时 confirm → POST 重算 → toast 汇报 */
  const auditWords = () => {
    if (auditing) return
    return runBusy(setAuditing, true, false, '字数审计失败', async () => {
      const res = await api<{
        books: number
        mismatches: { id: number; title: string; stored: number; actual: number }[]
        totalStored: number
        totalActual: number
      }>('/api/novels/recalc-words')
      if (res.mismatches.length === 0) {
        toast.success(`审计完成：${res.books} 本书字数与章节合计全部一致`)
        return
      }
      const sample = res.mismatches
        .slice(0, 3)
        .map((m) => `《${m.title.slice(0, 16)}》${m.stored}→${m.actual}`)
        .join('、')
      if (
        !confirm(
          `发现 ${res.mismatches.length} 本书字数与章节合计不符（${sample}...），立即全站重算？`,
        )
      )
        return
      const r2 = await api<{ books: number; mismatched: number; fixed: number }>(
        '/api/novels/recalc-words',
        { method: 'POST' },
      )
      toast.success(`重算完成：核对 ${r2.books} 本，修正 ${r2.fixed} 本`)
      // 书级字数变化，列表/首页缓存失效
      void qc.invalidateQueries()
    })
  }

  /** 全站目录重排：GET 只读审计 → 无候选 toast；有候选 confirm 样例 → POST 重排 → toast 汇报。
   * 沿用字数审计模式；后端 /api/novels/resort-chapters（GET 审计 / POST 执行）。 */
  const resortChapters = () => {
    if (resorting) return
    return runBusy(setResorting, true, false, '目录重排失败', async () => {
      const res = await api<{
        books: number
        candidates: { id: number; title: string; chapters: number; numbered: number; disorder: number }[]
      }>('/api/novels/resort-chapters')
      if (res.candidates.length === 0) {
        toast.success(`审计完成：${res.books} 本书目录顺序全部正常，无需重排`)
        return
      }
      const sample = res.candidates
        .slice(0, 3)
        .map((c) => `《${c.title.slice(0, 16)}》错乱 ${Math.round(c.disorder * 100)}%`)
        .join('、')
      if (!confirm(`发现 ${res.candidates.length} 本书目录疑似乱序（${sample}...），立即全站重排？重排只改阅读顺序不动内容。`)) return
      const r2 = await api<{
        scanned: number
        reordered: number
        results: { id: number; title: string; moved: number }[]
      }>('/api/novels/resort-chapters', { method: 'POST' })
      const moved = r2.results.reduce((s, x) => s + x.moved, 0)
      toast.success(`重排完成：审计 ${r2.scanned} 本，重排 ${r2.reordered} 本（涉及 ${moved} 章）`)
      // 章节 idx 与 updatedAt 变化，站点侧缓存全部失效
      void qc.invalidateQueries()
    })
  }

  return (
    <section className="rounded-lg border p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-sm font-semibold">
          <BookOpen className="h-4 w-4" /> 采集规则（{rules?.length ?? 0}）
        </h4>
        {/* flex-wrap：375px 视口下三个按钮放不下一行时换行，避免撑出横向滚动 */}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={cleanStored} disabled={cleaning}>
            <Eraser className="h-3.5 w-3.5" /> {cleaning ? '清洗中…' : '数据清洗维护'}
          </Button>
          <Button size="sm" variant="outline" onClick={auditWords} disabled={auditing}>
            <ChartLine className="h-3.5 w-3.5" /> {auditing ? '审计中…' : '字数审计'}
          </Button>
          <Button size="sm" variant="outline" onClick={resortChapters} disabled={resorting}>
            <ListOrdered className="h-3.5 w-3.5" /> {resorting ? '重排中…' : '目录重排'}
          </Button>
          <Button size="sm" variant="outline" onClick={seed} disabled={seeding}>
            <Sparkles className="h-3.5 w-3.5" /> 内置模板入库
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDialogRule(null)}>
            <Plus className="h-3.5 w-3.5" /> 新建规则
          </Button>
        </div>
      </div>

      <div className="max-h-72 overflow-y-auto">
        {rules === undefined ? (
          <p className="py-6 text-center text-xs text-neutral-400">规则加载中…</p>
        ) : rules.length === 0 ? (
          <p className="py-6 text-center text-xs text-neutral-400">
            暂无规则，点击「内置模板入库」或「新建规则」开始
          </p>
        ) : (
          <div className="space-y-1.5">
            {rules.map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs transition hover:bg-neutral-50"
              >
                <span className="min-w-0 flex-1 truncate font-medium" title={r.name}>
                  {r.name}
                </span>
                <span className="hidden max-w-40 truncate text-neutral-400 sm:inline" title={r.siteUrl}>
                  {truncate(r.siteUrl, 30)}
                </span>
                <Badge variant="outline" className="shrink-0 font-normal">
                  {r.charset}
                </Badge>
                <Switch checked={r.enabled} disabled={busyId === r.id} onCheckedChange={(v) => toggleEnabled(r, v)} aria-label={`启用规则 ${r.name}`} />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2"
                  onClick={() => setDialogRule(r)}
                  aria-label={`编辑规则 ${r.name}`}
                >
                  <Pencil className="h-3 w-3" /> 编辑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-red-500 hover:text-red-600"
                  disabled={busyId === r.id}
                  onClick={() => remove(r)}
                  aria-label={`删除规则 ${r.name}`}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {dialogRule !== undefined && (
        <RuleDialog
          key={dialogRule ? dialogRule.id : 'new'}
          initial={dialogRule}
          onClose={() => setDialogRule(undefined)}
          onSaved={refresh}
        />
      )}
    </section>
  )
}
