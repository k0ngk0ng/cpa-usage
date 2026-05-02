import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Session } from "../api/types";

interface UseSessionResult {
  session: Session | null;
  loading: boolean;
  refresh: () => Promise<void>;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export function useSession(): UseSessionResult {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const s = await api.session();
      setSession(s);
    } catch {
      setSession({ authenticated: false, auth_required: true });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const login = async (password: string) => {
    await api.login(password);
    await refresh();
  };

  const logout = async () => {
    await api.logout();
    await refresh();
  };

  return { session, loading, refresh, login, logout };
}
