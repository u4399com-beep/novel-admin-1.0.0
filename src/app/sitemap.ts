import type { MetadataRoute } from 'next'

// 站点基准 URL：sitemap 协议要求 <loc> 为绝对 URL，相对路径 "/" 是非法的
const BASE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, '')

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date()
  return [
    {
      url: `${BASE_URL}/`,
      lastModified: now,
      changeFrequency: 'hourly',
      priority: 1,
    },
  ]
}
