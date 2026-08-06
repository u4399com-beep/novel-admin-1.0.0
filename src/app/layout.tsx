import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "sonner";
import { Providers } from "@/components/Providers";
import { ScrollProgress } from "@/components/ScrollProgress";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { BackToTop } from "@/components/BackToTop";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: '小说阁 - 免费小说在线阅读',
    template: '%s - 小说阁',
  },
  description: "小说阁 — 专业的小说管理与阅读平台，轻松管理小说创作、分类、采集和阅读体验",
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <Providers>
          <ScrollProgress />
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[9999] focus:rounded-md focus:bg-primary focus:px-3 focus:py-1.5 focus:text-primary-foreground focus:text-sm focus:shadow-md focus:outline-none"
          >
            跳到主要内容
          </a>
          <main id="main-content">
            <ErrorBoundary name="root" reloadOnReset>
              {children}
            </ErrorBoundary>
          </main>
          <Toaster richColors position="top-right" />
          <BackToTop />
        </Providers>
      </body>
    </html>
  );
}