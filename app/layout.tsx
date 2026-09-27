import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "澄初 AI 金牌导购",
  description: "按你的需求、预算和使用习惯，结合澄初品牌手册给出个人护理商品建议。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
