// A promise somewhere in the core rejecting with nobody listening must not take the core down: Node
// ends the process for it, and main then restarts the core and reloads every window, which drops
// whatever a person was typing. It is logged instead; the call that failed has already failed.
import { consoleDiagnostics } from '@bolusi/device/ports/diagnostics';

interface RejectionSource {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
}

export function logUnhandledRejections(source: RejectionSource): void {
  source.on('unhandledRejection', (reason) => {
    consoleDiagnostics.warn('unhandled rejection in the core', {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });
}
