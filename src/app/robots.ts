import type { MetadataRoute } from 'next'

const BASE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, '')

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/' }],
    // 单页应用：仅主入口参与索引，sitemap 同样使用绝对 URL
    sitemap: `${BASE_URL}/sitemap.xml`,
  }
}
