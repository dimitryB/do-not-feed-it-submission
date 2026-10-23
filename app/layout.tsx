import type { Metadata } from "next";
import "./globals.css";

/**
 * The game's public address, baked in at build time (`DNFI_SITE_URL`, see
 * vite.config.ts). Link previews — Discord, X, Telegram — need absolute
 * image URLs, so the social card resolves against it; without it (local
 * development) the tags stay relative.
 */
const site = __DNFI_SITE_URL__;
const title = "Do Not Feed It";
const description = "Feed it your tokens. Deal with what it becomes. A free browser arcade game for Hemi Arcade: Turbo Edition — Bitcoin, Ether and HEMI, and a creature the whole community feeds.";
const card = { url: "/og.jpg", width: 1200, height: 630, alt: "DO NOT FEED IT. A hungry green creature behind a kitchen hatch." };

export const metadata: Metadata = {
  metadataBase: site ? new URL(site) : undefined,
  title,
  description,
  icons: { icon: [{ url: "/favicon.svg", type: "image/svg+xml" }], apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }] },
  openGraph: { type: "website", title, description, siteName: title, url: site || undefined, images: [card] },
  twitter: { card: "summary_large_image", title, description, images: [card] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
