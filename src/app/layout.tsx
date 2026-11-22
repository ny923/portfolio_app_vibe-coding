import type { Metadata } from "next";
import "./globals.css"; // Tailwind CSSなどのスタイルを読み込む

// ページのタイトルや説明文（SEO設定。WordPressのwp_head()周辺の役割）
export const metadata: Metadata = {
    title: "AIレシート家計簿",
    description: "レシートを撮影してAIで自動仕分けする家計簿アプリ",
    // ↓ OGP設定を追加
    openGraph: {
        title: "AIレシート家計簿",
        description: "レシートを撮影してAIで自動仕分けする家計簿アプリ",
        url: "https://kakeibo-app-brown.vercel.app/",
        siteName: "AIレシート家計簿",
        images: [
            {
                url: "https://kakeibo-app-brown.vercel.app/ogp.jpg", // 絶対URL（http/httpsから始まるURL）
                width: 1200,
                height: 630,
                alt: "AIレシート家計簿",
            },
        ],
        locale: "ja_JP",
        type: "website",
    },

};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        // ここに <html> と <body> が必須
        <html lang="ja">
            <body className="antialiased bg-gray-50 text-gray-900">
                {/* ↓page.tsx */}
                {children}
            </body>
        </html>
    );
}