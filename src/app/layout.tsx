import type { Metadata, Viewport } from "next";
import { Inter, Geist_Mono } from "next/font/google";

import { Providers } from "./providers";
import "./globals.css";
// Prebuilt Streamdown styles. We import the shipped CSS rather than the Tailwind 4
// `@source` directive because this project is on Tailwind 3.
import "streamdown/styles.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "ATS Analytics Copilot",
  description: "Multi-tenant ATS analytics copilot take-home.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#252525" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
