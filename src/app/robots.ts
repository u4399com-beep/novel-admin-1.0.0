import type { MetadataRoute } from 'next'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/' }],
    // 单页应用：仅主入口参与索引
    sitemap: undefined,
  }
}
