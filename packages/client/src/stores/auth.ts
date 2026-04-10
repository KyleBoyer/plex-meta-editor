import { create } from 'zustand';
import type { AuthUser } from '@plex-meta-editor/shared';
import * as authApi from '../api/auth.js';

interface AuthState {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  checkSession: () => Promise<void>;
  startLogin: () => Promise<{ authUrl: string; pinId: number }>;
  pollPin: (pinId: number) => Promise<boolean>;
  logout: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  error: null,

  checkSession: async () => {
    set({ isLoading: true, error: null });
    try {
      const session = await authApi.getAuthSession();
      if (session?.user) {
        set({ user: session.user, isAuthenticated: true, isLoading: false });
      } else {
        set({ user: null, isAuthenticated: false, isLoading: false });
      }
    } catch {
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },

  startLogin: async () => {
    set({ error: null });
    const pin = await authApi.createAuthPin();
    return { authUrl: pin.authUrl, pinId: pin.id };
  },

  pollPin: async (pinId: number) => {
    try {
      const result = await authApi.checkAuthPin(pinId);
      if (result.ready && result.token) {
        try {
          const user = await authApi.login(result.token);
          set({ user, isAuthenticated: true, error: null });
          return true;
        } catch (err) {
          const status = (err as Error & { status?: number }).status;
          if (status === 403) {
            set({
              error:
                "You don't have permission to access this server. Only the server owner can sign in.",
            });
          } else {
            set({ error: err instanceof Error ? err.message : 'Login failed' });
          }
          return true; // stop polling -- we got a definitive answer
        }
      }
      return false;
    } catch {
      // Network error during poll -- don't stop polling, just skip this tick
      return false;
    }
  },

  logout: async () => {
    try {
      await authApi.logout();
    } catch {
      // best-effort
    }
    set({ user: null, isAuthenticated: false, error: null });
  },

  clearError: () => set({ error: null }),
}));
