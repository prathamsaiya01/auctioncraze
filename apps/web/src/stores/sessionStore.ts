import { create } from 'zustand';
import { GuestSessionDto } from '@auctioncraze/shared';
import { api, SESSION_STORAGE_KEY, TOKEN_STORAGE_KEY } from '../lib/api';

interface SessionState {
  token: string | null;
  session: GuestSessionDto | null;
  isHydrated: boolean;
  isSubmitting: boolean;
  hydrate: () => Promise<void>;
  ensureSession: (displayName: string) => Promise<GuestSessionDto>;
  renameSession: (displayName: string) => Promise<GuestSessionDto>;
  clearSession: () => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  token: null,
  session: null,
  isHydrated: false,
  isSubmitting: false,

  hydrate: async () => {
    if (typeof window === 'undefined') return;
    const savedToken = localStorage.getItem(TOKEN_STORAGE_KEY);
    const savedSessionRaw = localStorage.getItem(SESSION_STORAGE_KEY);

    if (!savedToken) {
      set({ isHydrated: true });
      return;
    }

    if (savedSessionRaw) {
      try {
        const parsed = JSON.parse(savedSessionRaw) as GuestSessionDto;
        set({ token: savedToken, session: parsed });
      } catch {
        // ignore invalid cached json
      }
    }

    try {
      const res: any = await api.get('/sessions/me');
      const liveSession = res.data as GuestSessionDto;
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(liveSession));
      set({ token: savedToken, session: liveSession, isHydrated: true });
    } catch {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      localStorage.removeItem(SESSION_STORAGE_KEY);
      set({ token: null, session: null, isHydrated: true });
    }
  },

  ensureSession: async (displayName: string) => {
    const { token, session } = get();
    set({ isSubmitting: true });
    try {
      if (token && session) {
        if (session.displayName !== displayName.trim()) {
          return await get().renameSession(displayName);
        }
        return session;
      }

      const res: any = await api.post('/sessions/guest', { displayName: displayName.trim() });
      const { token: newToken, session: newSession } = res.data as {
        token: string;
        session: GuestSessionDto;
      };

      if (typeof window !== 'undefined') {
        localStorage.setItem(TOKEN_STORAGE_KEY, newToken);
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(newSession));
      }

      set({ token: newToken, session: newSession, isHydrated: true });
      return newSession;
    } finally {
      set({ isSubmitting: false });
    }
  },

  renameSession: async (displayName: string) => {
    set({ isSubmitting: true });
    try {
      const res: any = await api.patch('/sessions/me', { displayName: displayName.trim() });
      const updated = res.data as GuestSessionDto;
      if (typeof window !== 'undefined') {
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(updated));
      }
      set({ session: updated });
      return updated;
    } finally {
      set({ isSubmitting: false });
    }
  },

  clearSession: () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
    set({ token: null, session: null });
  }
}));
