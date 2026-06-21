import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "九墨 Jiumo｜水墨音樂可視化工作室",
  description: "瀏覽器內的開源音樂可視化工作室。",
  icons: { icon: "/seal-jiumo.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body className="bg-[#0a0809] text-white antialiased">{children}</body>
    </html>
  );
}
