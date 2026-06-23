import type { Metadata } from "next";

import { Providers } from "./providers";
import "./globals.css";
// Prebuilt Streamdown styles. We import the shipped CSS rather than the Tailwind 4
// `@source` directive because this project is on Tailwind 3.
import "streamdown/styles.css";

export const metadata: Metadata = {
  title: "ATS Analytics Copilot",
  description: "Multi-tenant ATS analytics copilot take-home.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
