import type { ReactNode } from "react";
import { LogoMark } from "./Logo";

/** Centered card layout for login, setup, invite and reset screens. */
export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <LogoMark size={44} className="mx-auto mb-3" />
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle ? <p className="text-sm text-muted">{subtitle}</p> : null}
        </div>
        <div className="rounded-lg border border-line bg-surface p-6">{children}</div>
      </div>
    </main>
  );
}
