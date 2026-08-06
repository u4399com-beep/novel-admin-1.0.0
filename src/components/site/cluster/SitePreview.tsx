'use client';

import type { Site, Theme, ThemeConfig } from '@/types';
import { tryParseJSON, defaultThemeConfig } from './helpers';

interface SitePreviewProps {
  site: Site;
  theme: Theme;
}

export function SitePreview({ site, theme }: SitePreviewProps) {
  const config: ThemeConfig = typeof theme.config === 'string'
    ? ((tryParseJSON(theme.config) as ThemeConfig) ?? defaultThemeConfig())
    : theme.config;
  const { colors, typography, layout } = config;

  const headingFont =
    typography.headingFont === 'serif' ? 'Georgia, "Times New Roman", serif'
    : typography.headingFont === 'mono' ? '"Courier New", monospace'
    : 'system-ui, -apple-system, sans-serif';

  const bodyFont =
    typography.bodyFont === 'serif' ? 'Georgia, "Times New Roman", serif'
    : typography.bodyFont === 'mono' ? '"Courier New", monospace'
    : 'system-ui, -apple-system, sans-serif';

  const cardRadius =
    layout.cardStyle === 'rounded' ? '16px'
    : layout.cardStyle === 'flat' ? '0px'
    : layout.cardStyle === 'bordered' ? '4px'
    : '12px';

  const cardBorder = layout.cardStyle === 'bordered' ? `1px solid ${colors.border}` : 'none';
  const cardShadow = layout.cardStyle === 'elevated' ? '0 4px 20px rgba(0,0,0,0.3)' : 'none';

  return (
    <div
      style={{
        background: colors.background,
        borderRadius: '12px',
        overflow: 'hidden',
        border: `1px solid ${colors.border}`,
      }}
    >
      {/* Header */}
      <div
        style={{
          background: colors.primary,
          padding: '16px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <h3
            style={{
              color: colors.background,
              fontSize: '16px',
              fontWeight: typography.headingWeight,
              fontFamily: headingFont,
              margin: 0,
            }}
          >
            {site.siteTitle || site.name}
          </h3>
          <p
            style={{
              color: `${colors.background}cc`,
              fontSize: '11px',
              margin: '2px 0 0',
            }}
          >
            {site.domain}
          </p>
        </div>
        <nav style={{ display: 'flex', gap: '16px' }}>
          {['首页', '分类', '排行', '书架'].map((item) => (
            <span
              key={item}
              style={{ color: `${colors.background}dd`, fontSize: '12px', cursor: 'pointer' }}
            >
              {item}
            </span>
          ))}
        </nav>
      </div>

      {/* Content */}
      <div style={{ padding: '24px' }}>
        <h4
          style={{
            color: colors.foreground,
            fontSize: '14px',
            fontWeight: typography.headingWeight,
            fontFamily: headingFont,
            marginBottom: '16px',
            paddingBottom: '8px',
            borderBottom: `2px solid ${colors.primary}`,
          }}
        >
          最新小说
        </h4>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${Math.min(layout.gridColumns, 3)}, 1fr)`,
            gap: '12px',
          }}
        >
          {['斗破苍穹', '凡人修仙传', '遮天'].map((title, i) => (
            <div
              key={title}
              style={{
                background: colors.card,
                borderRadius: cardRadius,
                border: cardBorder,
                boxShadow: cardShadow,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '80px',
                  background: i === 0 ? colors.primary : i === 1 ? colors.secondary : colors.accent,
                  opacity: 0.3,
                }}
              />
              <div style={{ padding: '10px' }}>
                <h5
                  style={{
                    color: colors.cardForeground,
                    fontSize: '12px',
                    fontWeight: 600,
                    fontFamily: headingFont,
                    margin: '0 0 4px',
                  }}
                >
                  {title}
                </h5>
                <p
                  style={{
                    color: colors.mutedForeground,
                    fontSize: '10px',
                    fontFamily: bodyFont,
                    lineHeight: typography.lineHeight,
                    margin: 0,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  这是一段示例小说简介文字，展示主题排版效果
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Footer info */}
        <div
          style={{
            marginTop: '16px',
            paddingTop: '12px',
            borderTop: `1px solid ${colors.border}`,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span style={{ color: colors.mutedForeground, fontSize: '10px', fontFamily: bodyFont }}>
            © 2024 {site.name} · {site.description || '在线小说阅读'}
          </span>
          <span style={{ color: colors.mutedForeground, fontSize: '10px' }}>
            GEO: {config.geo.region} / {config.geo.placename}
          </span>
        </div>
      </div>
    </div>
  );
}
