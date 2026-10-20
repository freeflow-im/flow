import { useEffect } from 'react';
import { getHost } from './host';

/**
 * The hardware back button as Escape (docs/design/ANDROID.md phase 1): while
 * the calling component is mounted, a back press in the Android shell closes
 * it instead of backgrounding the app. Registered on mount, so an overlay
 * that opened after the main pane sits above it in the handler stack and
 * wins — the same newest-first rule as everything in lib/hardwareBack.ts.
 * A no-op in a browser tab and on the desktop, whose hosts report no back.
 */
export function useBackToClose(onClose: () => void): void {
  useEffect(() => {
    return getHost().back.onBack(() => {
      onClose();
      return true;
    });
  }, [onClose]);
}
