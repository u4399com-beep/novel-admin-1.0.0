'use client'

import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThemeRenderer } from '@/components/ThemeRenderer'
import { AdminDrawer } from '@/components/AdminDrawer'
import { Toaster } from '@/components/ui/sonner'

export default function Home() {
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false },
        },
      })
  )

  return (
    <QueryClientProvider client={qc}>
      <ThemeRenderer />
      <AdminDrawer />
      <Toaster position="top-center" richColors />
    </QueryClientProvider>
  )
}
