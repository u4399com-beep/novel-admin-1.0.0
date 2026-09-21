'use client'

/**
 * 规则编辑/新建对话框（父组件条件渲染 + key 挂载，避免 effect 同步 state）。
 * 自 ScrapeCenter.tsx 原样拆分：选择器字段定义、分组渲染与保存逻辑保持不变。
 */

import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { BookRule, ChapterRule, ListRule, ScrapeRuleDto } from '@/lib/types'
import { runBusy } from '../ui-shared'
import { api, cleanRule } from './shared'
import type { FieldDef, RuleFormState } from './types'

const EMPTY_RULE_FORM: RuleFormState = {
  id: null,
  name: '',
  siteUrl: '',
  enabled: true,
  charset: 'utf-8',
  proxy: '',
  insecureTLS: false,
  notes: '',
  listRule: {},
  bookRule: {},
  chapterRule: {},
}

const CHARSETS = ['utf-8', 'gbk', 'gb2312', 'big5']

const LIST_FIELDS: FieldDef[] = [
  { key: 'itemSelector', label: '列表项 itemSelector', ph: '如 #newscontent li / .book-item' },
  { key: 'titleSelector', label: '书名 titleSelector', ph: '如 .s2 a' },
  { key: 'linkSelector', label: '书籍链接 linkSelector', ph: '默认 a[href]' },
  { key: 'authorSelector', label: '作者 authorSelector', ph: '如 .s5（可选）' },
  { key: 'categorySelector', label: '分类 categorySelector', ph: '分类选择器（可选）' },
  // Task 13-a：分页模板（杰奇系 /list/1_{k}.html 等形态，自动猜测永远落空时显式指定）
  {
    key: 'paginationTemplate',
    label: '分页模板 paginationTemplate',
    ph: '如 http://www.x2552.com/list/1_{k}.html（{k}=页码；留空=自动猜测翻页）',
  },
]

const BOOK_FIELDS: FieldDef[] = [
  { key: 'titleSelector', label: '书名 titleSelector', ph: '如 #info h1' },
  { key: 'authorSelector', label: '作者 authorSelector', ph: '如 #info p:first-of-type a' },
  { key: 'descriptionSelector', label: '简介 descriptionSelector', ph: '如 #intro' },
  { key: 'coverSelector', label: '封面 coverSelector', ph: '如 #fmimg img@src（可选）' },
  { key: 'statusSelector', label: '连载状态 statusSelector', ph: '如 .book-status（可选）' },
  { key: 'categorySelector', label: '分类 categorySelector', ph: '如 .book-cat（可选）' },
  { key: 'chapterLinkSelector', label: '章节链接 chapterLinkSelector', ph: '如 #list dl dd a；填 none 表示仅采书籍信息' },
  { key: 'catalogLinkSelector', label: '目录页链接 catalogLinkSelector', ph: '如 a.catalog-more（书页仅最新几章时用）' },
  { key: 'chapterTitleSelector', label: '章节标题 chapterTitleSelector', ph: '链接元素内标题选择器（可选）' },
  { key: 'excludeSelector', label: '排除选择器 excludeSelector', ph: '提取前移除的节点，如 h1.logo, .search' },
  // JSON 目录接口（同源 AJAX 端点提供全量目录的现代 CMS，实测 ixdzs8.com POST /novel/clist/）
  {
    key: 'chapterListApi',
    label: 'JSON 目录接口 chapterListApi（可选）',
    ph: '{"url":"/novel/clist/","bookIdSelector":"#bid@value","listPath":"data","titleField":"title","orderField":"ordernum","urlTemplate":"/read/{bookId}/p{order}.html"}',
  },
]

const CHAPTER_FIELDS: FieldDef[] = [
  { key: 'titleSelector', label: '章节标题 titleSelector', ph: '如 .bookname h1' },
  { key: 'contentSelector', label: '正文容器 contentSelector', ph: '如 #content' },
  { key: 'nextSelector', label: '下一页链接 nextSelector', ph: '如 #link_next（可选）' },
  { key: 'excludeSelector', label: '排除选择器 excludeSelector', ph: '提取前移除的节点，如 h1.logo, .search' },
]

function RuleFieldGroup({
  title,
  desc,
  fields,
  values,
  onChange,
}: {
  title: string
  desc: string
  fields: FieldDef[]
  values: ListRule | BookRule | ChapterRule
  onChange: (key: string, value: string) => void
}) {
  const rec = values as Record<string, string | undefined>
  return (
    <fieldset className="rounded-md border p-3">
      <legend className="px-1 text-xs font-semibold text-neutral-700">{title}</legend>
      <p className="mb-2 text-[11px] leading-relaxed text-neutral-400">{desc}</p>
      <div className="grid gap-x-3 gap-y-2 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.key} className="space-y-1">
            <Label className="text-[11px] font-medium text-neutral-500">{f.label}</Label>
            <Input
              value={rec[f.key] ?? ''}
              onChange={(e) => onChange(f.key, e.target.value)}
              placeholder={f.ph}
              className="h-8 text-xs"
            />
          </div>
        ))}
      </div>
    </fieldset>
  )
}

export function RuleDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial: ScrapeRuleDto | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<RuleFormState>(
    initial
      ? {
          id: initial.id,
          name: initial.name,
          siteUrl: initial.siteUrl,
          enabled: initial.enabled,
          charset: initial.charset,
          proxy: initial.proxy ?? '',
          insecureTLS: initial.insecureTLS === true,
          notes: initial.notes,
          listRule: initial.listRule ?? {},
          bookRule: initial.bookRule ?? {},
          chapterRule: initial.chapterRule ?? {},
        }
      : EMPTY_RULE_FORM,
  )
  const [saving, setSaving] = useState(false)

  const setGroup = (group: 'listRule' | 'bookRule' | 'chapterRule', key: string, value: string) =>
    setForm((f) => ({ ...f, [group]: { ...f[group], [key]: value } }))

  const save = () => {
    if (!form.name.trim()) return toast.error('规则名称必填')
    const url = form.siteUrl.trim()
    if (!url) return toast.error('站点 URL 必填')
    // 与服务端 parseSiteUrl 对齐的前置校验：避免明显非法的 URL 走一趟请求才报错
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return toast.error('站点 URL 仅支持 http/https 协议')
      }
    } catch {
      return toast.error('站点 URL 格式不正确')
    }
    const proxy = form.proxy.trim()
    if (proxy) {
      for (const part of proxy.split(',').map((p) => p.trim()).filter(Boolean)) {
        try {
          const p = new URL(part)
          if (!['http:', 'https:', 'socks5:', 'socks5h:', 'socks4:'].includes(p.protocol) || !p.host) {
            return toast.error('代理仅支持 http/https/socks5/socks5h 形态（如 socks5h://host:port）')
          }
        } catch {
          return toast.error(`代理格式不正确：${part.slice(0, 50)}（示例：socks5h://host:port，多个用英文逗号分隔）`)
        }
      }
    }
    return runBusy(setSaving, true, false, '保存失败', async () => {
      await api('/api/scrape-rules', {
        method: 'PUT',
        body: JSON.stringify({
          id: form.id ?? undefined,
          name: form.name.trim(),
          siteUrl: form.siteUrl.trim(),
          enabled: form.enabled,
          charset: form.charset,
          proxy,
          insecureTLS: form.insecureTLS,
          notes: form.notes,
          listRule: cleanRule(form.listRule),
          bookRule: cleanRule(form.bookRule),
          chapterRule: cleanRule(form.chapterRule),
        }),
      })
      toast.success(form.id ? '规则已保存' : '规则已创建')
      onSaved()
      onClose()
    })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{form.id ? '编辑采集规则' : '新建采集规则'}</DialogTitle>
          <DialogDescription>
            选择器支持逗号分隔的备选与 <code>sel@attr</code> 取属性语法；留空的字段将使用引擎内置启发式。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid gap-x-3 gap-y-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">规则名称 *</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="如：笔趣阁系通用模板"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">站点 URL *</Label>
              <Input
                value={form.siteUrl}
                onChange={(e) => setForm((f) => ({ ...f, siteUrl: e.target.value }))}
                placeholder="https://www.example.com/"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">编码 charset</Label>
              <Select value={form.charset} onValueChange={(v) => setForm((f) => ({ ...f, charset: v }))}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHARSETS.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">出口代理 proxy（空 = 直连）</Label>
              <Input
                value={form.proxy}
                onChange={(e) => setForm((f) => ({ ...f, proxy: e.target.value }))}
                placeholder="如 socks5h://user:pass@host:1080（反爬 IP 信誉突破）"
                className="h-8 text-xs"
              />
              <p className="text-[10px] leading-tight text-neutral-400">
                配置后策略链经该出口访问本站（美国/国内代理均可，用于绕过 IP 封锁）
              </p>
            </div>
            <div className="flex items-center gap-2 pt-5">
              <Switch
                id="rule-enabled"
                checked={form.enabled}
                onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
              />
              <Label htmlFor="rule-enabled" className="text-xs">
                启用该规则
              </Label>
            </div>
            <div className="flex items-center gap-2 pt-5">
              <Switch
                id="rule-insecure-tls"
                checked={form.insecureTLS}
                onCheckedChange={(v) => setForm((f) => ({ ...f, insecureTLS: v }))}
              />
              <Label htmlFor="rule-insecure-tls" className="text-xs">
                跳过 TLS 证书校验
              </Label>
            </div>
            <p className="text-[10px] leading-tight text-neutral-400 sm:col-span-2">
              跳过 TLS 证书校验仅用于自签证书/裸 IP 站点（如 https://38.34.172.127）；其余 SSRF/限速/挑战检测不变，非必要勿开。
            </p>
          </div>

          <RuleFieldGroup
            title="列表页规则 listRule（范围采集）"
            desc="用于从列表/分类页批量提取书籍条目；分页模板存在时第 2..N 页仅按模板生成（占位符 {k}=页码、{url}=首页 URL encode）。"
            fields={LIST_FIELDS}
            values={form.listRule}
            onChange={(k, v) => setGroup('listRule', k, v)}
          />
          <RuleFieldGroup
            title="书籍页规则 bookRule（单本/范围共用）"
            desc="用于从书页提取书籍信息与章节链接列表。"
            fields={BOOK_FIELDS}
            values={form.bookRule}
            onChange={(k, v) => setGroup('bookRule', k, v)}
          />
          <RuleFieldGroup
            title="正文页规则 chapterRule"
            desc="用于抓取单章正文内容。"
            fields={CHAPTER_FIELDS}
            values={form.chapterRule}
            onChange={(k, v) => setGroup('chapterRule', k, v)}
          />

          <div className="space-y-1">
            <Label className="text-xs">备注 notes</Label>
            <Textarea
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="站点结构说明、注意事项等"
              className="min-h-16 text-xs"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? '保存中…' : '保存规则'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
