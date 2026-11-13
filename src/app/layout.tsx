import type { Metadata, Viewport } from "next";
import { Rubik, Azeret_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

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
  title: "TITO KARAOKE STUDIO · אולפן קריוקי",
  description:
    "אולפן קריוקי מקצועי בדפדפן: הסרת קולות חיה, שינוי מפתח, ליריקה מסונכרנת, ניקוד זמרים בזמן אמת, הקלטות ואפקטים. Professional browser karaoke studio: live vocal removal, key shift, synced lyrics, real-time singing score, recording and mic effects.",
  keywords: [
    "karaoke",
    "קריוקי",
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
        <Toaster />
      </body>
    </html>
  );
}
