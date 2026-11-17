// A full-page message where an app's screen would be: no organization, a guest, no such app, no access, or no screen.
import type { ReactNode } from 'react';
import { AppWindow } from 'lucide-react';

export function Notice({ children, testid }: { children: ReactNode; testid: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-panel p-6">
      <div className="w-full max-w-md rounded-2xl border border-hairline bg-white p-8 text-center shadow-sm" data-testid={testid}>
        <div className="mx-auto mb-5 flex size-16 items-center justify-center rounded-2xl bg-primary-tint text-primary">
          <AppWindow className="size-8" strokeWidth={1.5} />
        </div>
        <div className="text-sm leading-relaxed text-muted">{children}</div>
      </div>
    </div>
  );
}
