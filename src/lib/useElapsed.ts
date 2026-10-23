import { useEffect, useState } from 'react';

/** Whole seconds since `active` became true; 0 while inactive. */
export function useElapsed(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return;
    const start = Date.now();
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 500);
    return () => {
      clearInterval(id);
      setSeconds(0);
    };
  }, [active]);
  return active ? seconds : 0;
}

/** The server stops at ~45 s; give up a little before Vercel's 60 s limit. */
export const CLIENT_TIMEOUT_MS = 58_000;

export function timeoutMessage(e: unknown): string | undefined {
  return e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')
    ? `No answer after ${CLIENT_TIMEOUT_MS / 1000} s. The free model API may be busy; try again.`
    : undefined;
}
