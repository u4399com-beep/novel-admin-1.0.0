import type { ThemeConfig } from '@/types';

// ─── Enhanced Theme Preview — Shows actual layout differences ──────────────

export function ThemePreviewCard({ config, name }: { config: ThemeConfig; name: string }) {
  const { colors, typography, layout } = config;
  const hFont = typography.headingFont === 'serif' ? 'Georgia,"Times New Roman",serif'
    : typography.headingFont === 'mono' ? '"Courier New",monospace'
    : 'system-ui,-apple-system,sans-serif';
  const bFont = typography.bodyFont === 'serif' ? 'Georgia,"Times New Roman",serif'
    : typography.bodyFont === 'mono' ? '"Courier New",monospace'
    : 'system-ui,-apple-system,sans-serif';

  const cardR = layout.cardStyle === 'rounded' ? '14px'
    : layout.cardStyle === 'flat' ? '0px'
    : layout.cardStyle === 'bordered' ? '3px'
    : '10px';
  const cardBdr = layout.cardStyle === 'bordered' ? `1px solid ${colors.border}` : 'none';
  const cardShd = layout.cardStyle === 'elevated' ? `0 4px 16px rgba(0,0,0,${isDark(colors.background) ? '0.5' : '0.08'})` : 'none';

  const isRight = layout.sidebarPosition === 'right';
  const cols = layout.gridColumns;

  return (
    <div
      style={{
        background: colors.background,
        borderRadius: '8px',
        padding: '0',
        overflow: 'hidden',
        border: `1px solid ${colors.border}`,
        position: 'relative',
      }}
    >
      {/* ── Header bar ── */}
      <div
        style={{
          background: colors.primary,
          padding: layout.headerStyle === 'fixed' ? '7px 10px' : '5px 10px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '6px',
        }}
      >
        <span style={{ color: '#fff', fontSize: '9px', fontWeight: typography.headingWeight, fontFamily: hFont, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {name}
        </span>
        <div style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
          {layout.headerStyle === 'fixed' && (
            <div style={{ width: '4px', height: '4px', borderRadius: '50%', background: colors.accent, opacity: 0.8 }} />
          )}
          <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: colors.secondary, opacity: 0.7 }} />
        </div>
      </div>

      {/* ── Body: sidebar + content ── */}
      <div style={{ display: 'flex', minHeight: '110px' }}>
        {/* Sidebar */}
        <div
          style={{
            width: '36px',
            minWidth: '36px',
            background: colors.muted,
            borderRight: isRight ? 'none' : `1px solid ${colors.border}`,
            borderLeft: isRight ? `1px solid ${colors.border}` : 'none',
            padding: '5px 4px',
            display: 'flex',
            flexDirection: 'column',
            gap: '3px',
            order: isRight ? 2 : 0,
          }}
        >
          {['导航', '分类', '标签', '排行'].map((label, i) => (
            <div
              key={label}
              style={{
                fontSize: '6px',
                color: i === 0 ? colors.primary : colors.mutedForeground,
                fontFamily: bFont,
                padding: '2px 3px',
                borderRadius: '2px',
                background: i === 0 ? (isDark(colors.background) ? `${colors.primary}22` : `${colors.primary}15`) : 'transparent',
                fontWeight: i === 0 ? 600 : 400,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {label}
            </div>
          ))}
        </div>

        {/* Main content area */}
        <div style={{ flex: 1, padding: '6px', display: 'flex', flexDirection: 'column', gap: '5px', order: 1 }}>
          {/* Section heading */}
          <p style={{
            color: colors.foreground,
            fontSize: '8px',
            fontWeight: typography.headingWeight,
            fontFamily: hFont,
            margin: 0,
            letterSpacing: typography.headingFont === 'mono' ? '0.5px' : '0',
          }}>
            最新小说
          </p>

          {/* Novel cards grid */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            gap: '4px',
          }}>
            {Array.from({ length: cols }).map((_, i) => (
              <div
                key={i}
                style={{
                  background: colors.card,
                  color: colors.cardForeground,
                  borderRadius: cardR,
                  border: cardBdr,
                  boxShadow: cardShd,
                  padding: '5px',
                  overflow: 'hidden',
                }}
              >
                {/* Mini cover */}
                <div style={{
                  width: '100%',
                  height: cols === 4 ? '18px' : '22px',
                  borderRadius: cardR === '0px' ? '0' : `${Math.min(Number(cardR), 6)}px`,
                  background: `linear-gradient(135deg, ${colors.muted} 0%, ${colors.border} 100%)`,
                  marginBottom: '3px',
                }} />
                {/* Title */}
                <div style={{
                  width: `${80 - i * 8}%`,
                  height: '4px',
                  borderRadius: '2px',
                  background: colors.foreground,
                  marginBottom: '2px',
                  opacity: 0.6,
                }} />
                {/* Subtitle */}
                <div style={{
                  width: `${55 - i * 5}%`,
                  height: '3px',
                  borderRadius: '1.5px',
                  background: colors.mutedForeground,
                  opacity: 0.4,
                }} />
              </div>
            ))}
          </div>

          {/* Text sample */}
          <div style={{ marginTop: '1px' }}>
            <p style={{
              color: colors.mutedForeground,
              fontSize: '6px',
              fontFamily: bFont,
              lineHeight: typography.lineHeight,
              margin: 0,
              overflow: 'hidden',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
            }}>
              正文内容示例，展示当前主题的排版效果与配色方案。字体行高{typography.lineHeight}，{typography.headingFont === 'serif' ? '衬线' : typography.headingFont === 'mono' ? '等宽' : '无衬线'}字体。
            </p>
          </div>
        </div>
      </div>

      {/* ── Footer with layout badges ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '4px 8px',
        borderTop: `1px solid ${colors.border}`,
        background: colors.muted,
      }}>
        <div style={{ display: 'flex', gap: '3px' }}>
          {[
            `${layout.maxWidth.replace('px', '')}w`,
            `${cols}col`,
            layout.cardStyle.slice(0, 3),
            isRight ? 'R栏' : 'L栏',
          ].map((tag) => (
            <span
              key={tag}
              style={{
                fontSize: '5px',
                fontFamily: '"Courier New",monospace',
                color: colors.mutedForeground,
                background: colors.background,
                padding: '1px 3px',
                borderRadius: '2px',
                border: `1px solid ${colors.border}`,
                lineHeight: 1.4,
              }}
            >
              {tag}
            </span>
          ))}
        </div>
        {/* Color palette dots */}
        <div style={{ display: 'flex', gap: '2px' }}>
          {[colors.primary, colors.secondary, colors.accent, colors.card, colors.muted].map((c, i) => (
            <div
              key={i}
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: c,
                border: `1px solid ${colors.border}`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function isDark(bg: string): boolean {
  const hex = bg.replace('#', '');
  if (hex.length !== 6) return false;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}