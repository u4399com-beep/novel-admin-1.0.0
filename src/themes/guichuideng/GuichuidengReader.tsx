'use client';

import React, { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, List, Settings2, Loader2, RotateCcw } from 'lucide-react';
import type { Chapter } from '@/app/novels/[id]/reader/types';

// ─── Reader Settings ─────────────────────────────────────────────

const GC_READER_SETTINGS_KEY = 'guichuideng-reader-settings';

interface GcReaderSettings {
  fontFamily: string;
  fontSize: number;
  bgKey: string;
}

const GC_FONT_FAMILIES = [
  { key: 'songti', label: '宋体', css: '"SimSun", "STSong", serif' },
  { key: 'heiti', label: '黑体', css: '"SimHei", "STHeiti", sans-serif' },
  { key: 'kaiti', label: '楷体', css: '"KaiTi", "STKaiti", cursive' },
  { key: 'yahei', label: '雅黑', css: '"Microsoft YaHei", "PingFang SC", sans-serif' },
];

const GC_BG_THEMES = [
  { key: 'default', label: '默认', bg: '#fff', text: '#333' },
  { key: 'eye-care', label: '护眼', bg: '#c7edcc', text: '#3b3b3b' },
  { key: 'night', label: '夜间', bg: '#1a1a2e', text: '#b0b0b0' },
  { key: 'sepia', label: '淡黄', bg: '#f5f0e1', text: '#5b4636' },
];

const GC_DEFAULT_SETTINGS: GcReaderSettings = {
  fontFamily: 'songti',
  fontSize: 18,
  bgKey: 'default',
};

function loadGcSettings(): GcReaderSettings {
  try {
    const saved = localStorage.getItem(GC_READER_SETTINGS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<GcReaderSettings>;
      return {
        ...GC_DEFAULT_SETTINGS,
        ...parsed,
        fontSize: Math.max(16, Math.min(28, parsed.fontSize ?? 18)),
      };
    }
  } catch { /* ignore */ }
  return GC_DEFAULT_SETTINGS;
}

function saveGcSettings(s: GcReaderSettings): void {
  try { localStorage.setItem(GC_READER_SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

// ─── Props ────────────────────────────────────────────────────────

interface GuichuidengReaderProps {
  novelId: string;
  novelTitle: string;
  chapters: Chapter[];
  initialChapterIndex: number;
  content: string | null;
  loading: boolean;
  error: boolean;
  onChapterChange: (index: number) => void;
  onRetry: () => void;
  siteName: string;
}

// ─── Component ────────────────────────────────────────────────────

export function GuichuidengReader({
  novelId,
  novelTitle,
  chapters,
  initialChapterIndex,
  content,
  loading,
  error,
  onChapterChange,
  onRetry,
  siteName,
}: GuichuidengReaderProps) {
  const [settings, setSettings] = useState<GcReaderSettings>(GC_DEFAULT_SETTINGS);
  const contentRef = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chapterListOpen, setChapterListOpen] = useState(false);

  const currentChapterIndex = initialChapterIndex;
  const chapter = chapters[currentChapterIndex];
  const prevChapter = currentChapterIndex > 0 ? chapters[currentChapterIndex - 1] : null;
  const nextChapter = currentChapterIndex < chapters.length - 1 ? chapters[currentChapterIndex + 1] : null;

  // Scroll to top on chapter change
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [initialChapterIndex]);

  const updateSetting = useCallback((partial: Partial<GcReaderSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      saveGcSettings(next);
      return next;
    });
  }, []);

  const currentBg = GC_BG_THEMES.find((t) => t.key === settings.bgKey) || GC_BG_THEMES[0];
  const currentFont = GC_FONT_FAMILIES.find((f) => f.key === settings.fontFamily) || GC_FONT_FAMILIES[0];

  // Render paragraph content
  const renderContent = (): ReactNode => {
    if (loading) {
      return (
        <div className="flex items-center justify-center py-20 gap-3">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          <span className="text-sm text-gray-400">加载中...</span>
        </div>
      );
    }
    if (error) {
      return (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <p className="text-sm text-gray-400">加载章节内容失败</p>
          <button
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm border border-gray-300 rounded text-gray-600 hover:text-orange-500 hover:border-orange-300 transition-colors"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            重试
          </button>
        </div>
      );
    }
    if (!content) return null;

    return content.split('\n').map((paragraph, i) => {
      const text = paragraph.trim() || '\u00A0';
      return (
        <p
          key={i}
          className={paragraph.trim() ? 'mb-0' : 'h-5'}
          style={{ textIndent: paragraph.trim() ? '2em' : undefined }}
        >
          {text}
        </p>
      );
    });
  };

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: currentBg.bg }}>
      {/* ─── Topbar ──────────────────────────────────────────── */}
      <div className="bg-[#333] text-white/70 text-xs">
        <div className="max-w-[960px] mx-auto px-3 py-1.5 flex items-center justify-between">
          <Link href="/" className="hover:text-white transition-colors">
            {siteName || '小说阅读网'}
          </Link>
          <span>
            {chapter ? `${currentChapterIndex + 1}/${chapters.length}` : ''}
          </span>
        </div>
      </div>

      {/* ─── Breadcrumb + Title ───────────────────────────────── */}
      <div
        className="border-b"
        style={{ backgroundColor: currentBg.bg, borderColor: currentBg.text + '20' }}
      >
        <div className="max-w-[960px] mx-auto px-3 py-3">
          <div className="flex items-center gap-1.5 text-xs mb-2" style={{ color: currentBg.text + '80' }}>
            <Link href="/" className="hover:text-orange-500 transition-colors">首页</Link>
            <span>/</span>
            <Link href={`/novels/${novelId}`} className="hover:text-orange-500 transition-colors">
              {novelTitle}
            </Link>
            <span>/</span>
            <span>{chapter?.title || '...'}</span>
          </div>
          <h1
            className="text-xl font-bold text-center"
            style={{ color: currentBg.text }}
          >
            {chapter?.title || '加载中...'}
          </h1>
        </div>
      </div>

      {/* ─── Settings bar ────────────────────────────────────── */}
      <div
        className="border-b"
        style={{
          backgroundColor: currentBg.bg,
          borderColor: currentBg.text + '15',
        }}
      >
        <div className="max-w-[960px] mx-auto px-3 py-2 flex items-center justify-between">
          {/* Left: Font family selector */}
          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: currentBg.text + '60' }}>字体:</span>
            {GC_FONT_FAMILIES.map((f) => (
              <button
                key={f.key}
                onClick={() => updateSetting({ fontFamily: f.key })}
                className={`px-2 py-0.5 text-xs rounded transition-colors ${
                  settings.fontFamily === f.key
                    ? 'bg-orange-500 text-white'
                    : 'hover:bg-gray-200'
                }`}
                style={settings.fontFamily !== f.key ? { color: currentBg.text } : undefined}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Right: Font size + bg toggle */}
          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: currentBg.text + '60' }}>字号:</span>
            <button
              onClick={() => updateSetting({ fontSize: Math.max(16, settings.fontSize - 2) })}
              className="w-6 h-6 flex items-center justify-center rounded text-xs hover:bg-gray-200 transition-colors"
              style={{ color: currentBg.text }}
              disabled={settings.fontSize <= 16}
            >
              A-
            </button>
            <span className="text-xs w-8 text-center" style={{ color: currentBg.text }}>
              {settings.fontSize}
            </span>
            <button
              onClick={() => updateSetting({ fontSize: Math.min(28, settings.fontSize + 2) })}
              className="w-6 h-6 flex items-center justify-center rounded text-xs hover:bg-gray-200 transition-colors"
              style={{ color: currentBg.text }}
              disabled={settings.fontSize >= 28}
            >
              A+
            </button>

            <span className="mx-1 text-gray-300">|</span>

            {GC_BG_THEMES.map((bg) => (
              <button
                key={bg.key}
                onClick={() => updateSetting({ bgKey: bg.key })}
                className={`w-5 h-5 rounded-full border-2 transition-transform ${
                  settings.bgKey === bg.key ? 'scale-110 border-orange-400' : 'border-gray-300'
                }`}
                style={{ backgroundColor: bg.bg }}
                title={bg.label}
              />
            ))}
          </div>
        </div>
      </div>

      {/* ─── Chapter navigation (top) ────────────────────────── */}
      <div className="max-w-[960px] mx-auto w-full px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => prevChapter && onChapterChange(currentChapterIndex - 1)}
            disabled={!prevChapter}
            className={`inline-flex items-center gap-1 px-4 py-1.5 text-sm rounded border transition-colors ${
              prevChapter
                ? 'border-gray-300 text-[#265d79] hover:text-[#c00] hover:border-[#c00]'
                : 'border-gray-200 text-gray-300 cursor-not-allowed'
            }`}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            上一章
          </button>

          <button
            onClick={() => setChapterListOpen(!chapterListOpen)}
            className="inline-flex items-center gap-1 px-4 py-1.5 text-sm rounded border border-gray-300 text-[#265d79] hover:text-[#c00] hover:border-[#c00] transition-colors"
          >
            <List className="h-3.5 w-3.5" />
            章节列表
          </button>

          <button
            onClick={() => nextChapter && onChapterChange(currentChapterIndex + 1)}
            disabled={!nextChapter}
            className={`inline-flex items-center gap-1 px-4 py-1.5 text-sm rounded border transition-colors ${
              nextChapter
                ? 'border-gray-300 text-[#265d79] hover:text-[#c00] hover:border-[#c00]'
                : 'border-gray-200 text-gray-300 cursor-not-allowed'
            }`}
          >
            下一章
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Chapter list dropdown */}
        {chapterListOpen && (
          <div className="mt-2 border border-gray-200 rounded bg-white shadow-lg max-h-[300px] overflow-y-auto custom-scrollbar">
            <ul className="p-2">
              {chapters.map((ch, i) => (
                <li key={ch.id}>
                  <button
                    onClick={() => {
                      onChapterChange(i);
                      setChapterListOpen(false);
                    }}
                    className={`flex items-center gap-2 w-full px-2 py-1.5 text-left text-sm rounded transition-colors ${
                      i === currentChapterIndex
                        ? 'bg-orange-50 text-orange-600 font-medium'
                        : 'text-gray-700 hover:bg-gray-50 hover:text-[#c00]'
                    }`}
                  >
                    <span className="text-gray-300 text-xs w-8 shrink-0 text-right">
                      {i + 1}.
                    </span>
                    <span className="line-clamp-1">{ch.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* ─── Content area ─────────────────────────────────────── */}
      <div
        ref={contentRef}
        className="flex-1 overflow-y-auto"
      >
        <div
          className="max-w-[700px] mx-auto px-4 sm:px-6 py-4 transition-colors duration-300"
          style={{
            backgroundColor: currentBg.bg,
            color: currentBg.text,
            fontFamily: currentFont.css,
            fontSize: `${settings.fontSize}px`,
            lineHeight: '1.9',
          }}
        >
          {renderContent()}
        </div>
      </div>

      {/* ─── Bottom navigation ───────────────────────────────── */}
      <div className="max-w-[960px] mx-auto w-full px-3 py-4">
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => prevChapter && onChapterChange(currentChapterIndex - 1)}
            disabled={!prevChapter}
            className={`inline-flex items-center gap-1 px-4 py-1.5 text-sm rounded border transition-colors ${
              prevChapter
                ? 'border-gray-300 text-[#265d79] hover:text-[#c00] hover:border-[#c00]'
                : 'border-gray-200 text-gray-300 cursor-not-allowed'
            }`}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            上一章
          </button>

          <Link
            href={`/novels/${novelId}`}
            className="inline-flex items-center gap-1 px-4 py-1.5 text-sm rounded border border-gray-300 text-[#265d79] hover:text-[#c00] hover:border-[#c00] transition-colors"
          >
            书籍详情
          </Link>

          <button
            onClick={() => nextChapter && onChapterChange(currentChapterIndex + 1)}
            disabled={!nextChapter}
            className={`inline-flex items-center gap-1 px-4 py-1.5 text-sm rounded border transition-colors ${
              nextChapter
                ? 'border-gray-300 text-[#265d79] hover:text-[#c00] hover:border-[#c00]'
                : 'border-gray-200 text-gray-300 cursor-not-allowed'
            }`}
          >
            下一章
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ─── Hot recommendations ──────────────────────────────── */}
      <div
        className="border-t"
        style={{ borderColor: currentBg.text + '15' }}
      >
        <div className="max-w-[960px] mx-auto px-3 py-4">
          <h3 className="text-sm font-semibold text-center mb-3" style={{ color: currentBg.text }}>
            热门推荐
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {/* Placeholder recommendation cards */}
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="text-center p-3 rounded border transition-colors cursor-pointer hover:border-orange-300"
                style={{
                  borderColor: currentBg.text + '20',
                  backgroundColor: currentBg.bg,
                  color: currentBg.text,
                }}
              >
                <div
                  className="w-16 h-22 mx-auto rounded bg-gray-200 mb-2"
                  style={{ backgroundColor: currentBg.text + '10' }}
                />\n                <p className="text-xs line-clamp-1">推荐小说 {i + 1}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ─── Footer ───────────────────────────────────────────── */}
      <footer className="bg-[#333] text-white/50 text-xs">
        <div className="max-w-[960px] mx-auto px-3 py-4 text-center space-y-1">
          <p>Copyright © {new Date().getFullYear()} {siteName || '小说阅读网'} All Rights Reserved.</p>
        </div>
      </footer>
    </div>
  );
}
