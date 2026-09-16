import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// 服务端默认 TDK；客户端 SeoSync 会按视图/数据实时覆盖
export const metadata: Metadata = {
  title: "青阅文学 - 免费小说在线阅读",
  description:
    "青阅文学是免费原创小说在线阅读网站，提供玄幻、仙侠、都市、历史、科幻等全品类小说，每日更新。",
  keywords: ["小说", "免费小说", "在线阅读", "玄幻小说", "都市小说"],
  openGraph: {
    title: "青阅文学 - 免费小说在线阅读",
    description: "海量原创小说每日更新，畅享极致阅读体验。",
    siteName: "青阅文学",
    type: "website",
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
        {children}
      </body>
    </html>
  );
}
