'use client'

import { useState } from 'react'
import { Settings } from 'lucide-react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThemeRenderer } from '@/components/ThemeRenderer'
import { AdminConsole, useHashAdmin } from '@/components/admin/AdminConsole'
import { Toaster } from '@/components/ui/sonner'

/** 浮动齿轮按钮：进入独立管理后台（hash 路由 #/admin） */
function AdminLauncher() {
  return (
    <button
      aria-label="进入站点管理后台"
      onClick={() => { window.location.hash = '#/admin' }}
      className="fixed bottom-5 right-5 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-neutral-900 text-white shadow-lg transition hover:scale-105 hover:bg-neutral-700"
    >
      <Settings className="h-5 w-5" />
    </button>
  )
}

export default function Home() {
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false },
        },
      })
  )
  const isAdmin = useHashAdmin()

  return (
    <QueryClientProvider client={qc}>
      {isAdmin ? <AdminConsole /> : <ThemeRenderer />}
      {!isAdmin && <AdminLauncher />}
      <Toaster position="top-center" richColors />
    </QueryClientProvider>
  )
}
