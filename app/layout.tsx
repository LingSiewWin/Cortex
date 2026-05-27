import type { Metadata } from "next";
import { headers } from "next/headers";
import { WebProviders } from "@/lib/web/providers";
import "../ui/styles.css";
import "../ui/landing-editorial.css";
import "../ui/console-editorial.css";

export const metadata: Metadata = {
  title: "Cortex — Darwinian memory on Arkiv",
  description: "Memories reinforce on cited utility; useless ones decay for free.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const headersList = await headers();
  const cookies = headersList.get("cookie");

  return (
    <html lang="en">
      <body>
        <WebProviders cookies={cookies}>{children}</WebProviders>
      </body>
    </html>
  );
}
