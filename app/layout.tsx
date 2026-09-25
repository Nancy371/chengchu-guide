import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "澄初 AI 金牌导购",
  description: "基于澄初品牌手册与确定性业务规则的个人护理商品导购。",
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
