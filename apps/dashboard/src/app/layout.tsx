// Root layout — wraps the app in ClerkProvider.
//
// The publishable key is read from NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (exposed
// to the browser). The ClerkProvider enables auth() / useAuth() / useUser()
// across server + client components.

import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Graphbrain",
  description: "Your personal knowledge brain.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <ClerkProvider
      publishableKey={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}
    >
      <html lang="en">
        <body className="min-h-screen bg-neutral-50 text-neutral-900 antialiased">
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
