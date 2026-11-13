import type { Metadata, Viewport } from "next";
import { Rubik, Azeret_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

const rubik = Rubik({
  variable: "--font-rubik",
  subsets: ["hebrew", "latin", "cyrillic"],
  weight: ["300", "400", "500", "600", "700", "800", "900"],
});

const azeretMono = Azeret_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "TITO KARAOKE v3.4 · אולפן קריוקי טיטו — FULL SONGS, VERIFIED",
  description:
    "קריוקי בדפדפן שסוף סוף עובד: חיפוש שירים מובנה (בלי ייבוא קבצים), מילים מסונכרנות אוטומטית ברמת המילה עם AI, שיר מלא דרך YouTube, הסרת קולות חיה, ניקוד זמרים בזמן אמת והקלטות. A karaoke studio that finally works: built-in search, AI-synced word-level lyrics, full songs via YouTube, live vocal removal, real-time scoring and recordings.",
  keywords: [
    "karaoke",
    "קריוקי",
    "חיפוש שירים",
    "vocal remover",
    "pitch",
    "LRC",
    "singing score",
    "web audio",
  ],
  authors: [{ name: "DJ TiTo" }],
};

export const viewport: Viewport = {
  themeColor: "#0d0f14",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="he" dir="rtl" suppressHydrationWarning>
      <body
        className={`${rubik.variable} ${azeretMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster position="top-center" richColors theme="dark" />
      </body>
    </html>
  );
}
