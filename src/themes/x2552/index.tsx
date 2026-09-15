'use client'

import type { ThemeModule, ViewProps } from '../types'

function Placeholder({ label }: { label: string }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-8">
      <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-6 py-10 text-center">
        <p className="text-lg font-semibold text-neutral-700">{label}</p>
        <p className="mt-2 text-sm text-neutral-500">主题模板构建中，请稍候…</p>
      </div>
    </div>
  )
}

const theme: ThemeModule = {
  id: 'x2552',
  name: 'x2552',
  source: '',
  description: '构建中',
  swatch: ['#888', '#ccc'],
  Layout: ({ children }) => <>{children}</>,
  Home: (_p: ViewProps) => <Placeholder label="x2552 / Home" />,
  Category: (_p: ViewProps) => <Placeholder label="x2552 / Category" />,
  Book: (_p: ViewProps) => <Placeholder label="x2552 / Book" />,
  Toc: (_p: ViewProps) => <Placeholder label="x2552 / Toc" />,
  Chapter: (_p: ViewProps) => <Placeholder label="x2552 / Chapter" />,
  Search: (_p: ViewProps) => <Placeholder label="x2552 / Search" />,
}

export default theme
