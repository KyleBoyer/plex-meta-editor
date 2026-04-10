import type { AuthUser, AuthSession, PinResponse } from '@plex-meta-editor/shared';

const API_BASE = '/api';

/**
 * Raw fetch helper for auth endpoints. Uses the same pattern as client.ts
 * but returns the parsed ApiResponse data directly.
 */
async function authRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...options,
  });

  const json = await res.json();

  if (!json.success) {
    const err = new Error(json.error || 'Unknown auth error');
    // Attach status code for callers that need to distinguish 403 etc.
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }

  return json.data as T;
}

export async function createAuthPin(): Promise<PinResponse> {
  return authRequest<PinResponse>('/auth/pin', { method: 'POST' });
}

export async function checkAuthPin(pinId: number): Promise<{ ready: boolean; token?: string }> {
  return authRequest<{ ready: boolean; token?: string }>(`/auth/pin/${pinId}`);
}

export async function login(token: string): Promise<AuthUser> {
  return authRequest<AuthUser>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

export async function logout(): Promise<void> {
  return authRequest<void>('/auth/logout', { method: 'POST' });
}

export async function getAuthSession(): Promise<AuthSession | null> {
  return authRequest<AuthSession | null>('/auth/session');
}
