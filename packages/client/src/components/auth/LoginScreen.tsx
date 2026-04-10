import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuthStore } from '../../stores/auth';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function PlexIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M11.643 0H4.68l7.679 12L4.68 24h6.963L19.32 12 11.643 0Z" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
    >
      <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
    </svg>
  );
}

export function LoginScreen() {
  const { isAuthenticated, error, startLogin, pollPin, clearError } = useAuthStore();
  const [waiting, setWaiting] = useState(false);
  const [starting, setStarting] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const authWindowRef = useRef<Window | null>(null);

  const cleanup = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    authWindowRef.current = null;
  }, []);

  // Clean up on unmount or when authenticated
  useEffect(() => {
    if (isAuthenticated) cleanup();
    return cleanup;
  }, [isAuthenticated, cleanup]);

  const handleSignIn = async () => {
    clearError();
    setStarting(true);

    try {
      const { authUrl, pinId } = await startLogin();

      // Open Plex auth in a centered popup window
      const w = 600;
      const h = 700;
      const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
      const top = Math.round(window.screenY + (window.outerHeight - h) / 2);
      const popup = window.open(
        authUrl,
        'plex-auth',
        `width=${w},height=${h},left=${left},top=${top},toolbar=no,menubar=no,location=no,status=no`,
      );
      authWindowRef.current = popup;

      setWaiting(true);
      setStarting(false);

      // Start polling for auth completion
      pollTimerRef.current = setInterval(async () => {
        // If user closed the popup manually, stop polling
        if (popup && popup.closed) {
          cleanup();
          setWaiting(false);
          return;
        }

        const done = await pollPin(pinId);
        if (done) {
          // Force close the popup
          try { popup?.close(); } catch { /* cross-origin safe */ }
          cleanup();
          setWaiting(false);
        }
      }, POLL_INTERVAL_MS);

      // Timeout after 5 minutes
      timeoutRef.current = setTimeout(() => {
        cleanup();
        setWaiting(false);
        useAuthStore.setState({
          error: 'Authorization timed out. Please try again.',
        });
      }, POLL_TIMEOUT_MS);
    } catch (err) {
      setStarting(false);
      setWaiting(false);
      useAuthStore.setState({
        error: err instanceof Error ? err.message : 'Failed to start login',
      });
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-[var(--color-page-background)]">
      <div className="flex flex-col items-center gap-8 px-6 max-w-sm w-full">
        {/* Brand */}
        <div className="flex flex-col items-center gap-3">
          <svg aria-hidden="true" height="48" viewBox="0 0 72 28" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
            <text x="0" y="22" fontFamily="'Open Sans', sans-serif" fontWeight="700" fontSize="22" letterSpacing="1" fill="white">P</text>
            <text x="17" y="22" fontFamily="'Open Sans', sans-serif" fontWeight="700" fontSize="22" letterSpacing="1" fill="#e5a00d">M</text>
            <text x="42" y="22" fontFamily="'Open Sans', sans-serif" fontWeight="700" fontSize="22" letterSpacing="1" fill="white">E</text>
          </svg>
          <h1 className="text-lg font-semibold text-[var(--color-text-primary)] tracking-tight">
            Plex Meta Editor
          </h1>
          <p className="text-sm text-[var(--color-text-muted)] text-center">
            Sign in with your Plex account to continue
          </p>
        </div>

        {/* Card */}
        <div
          className="w-full rounded-[var(--radius-m)] p-6 flex flex-col items-center gap-5"
          style={{
            background: 'var(--color-surface-2)',
            border: '1px solid var(--color-border)',
          }}
        >
          {error && (
            <div
              className="w-full rounded-[var(--radius-s)] px-4 py-3 text-sm leading-relaxed"
              style={{
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.25)',
                color: '#fca5a5',
              }}
            >
              {error}
            </div>
          )}

          {waiting ? (
            <div className="flex flex-col items-center gap-4 py-2">
              <Spinner />
              <div className="text-center">
                <p className="text-sm font-medium text-[var(--color-text-default)]">
                  Waiting for authorization...
                </p>
                <p className="text-xs text-[var(--color-text-faint)] mt-1">
                  Complete sign-in in the Plex window
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  cleanup();
                  setWaiting(false);
                }}
                className="text-xs text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)] transition-colors mt-1"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void handleSignIn()}
              disabled={starting}
              className="w-full flex items-center justify-center gap-2.5 rounded-[var(--radius-s)] px-5 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50 cursor-pointer"
              style={{
                background: 'var(--color-accent)',
                color: '#000',
              }}
              onMouseEnter={(e) => {
                if (!starting) e.currentTarget.style.background = 'var(--color-accent-hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--color-accent)';
              }}
            >
              {starting ? (
                <Spinner />
              ) : (
                <>
                  <PlexIcon />
                  Sign in with Plex
                </>
              )}
            </button>
          )}
        </div>

        <p className="text-xs text-[var(--color-text-faint)] text-center">
          Only the Plex server owner can access this tool.
        </p>
      </div>
    </div>
  );
}
