import type { MetadataRoute } from 'next'

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date()
  return [
    {
      url: '/',
      lastModified: now,
      changeFrequency: 'hourly',
      priority: 1,
    },
  ]
}
