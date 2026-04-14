import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { toast } from "@/hooks/use-toast";
import {
  AdminPermissionLevel,
  hasPermissionLevel,
  resolvePermissionLevel,
} from "@/lib/adminPermissions";
import {
  isAdminSessionIdleExpired,
  resolveAdminSessionPolicy,
  shouldRefreshAdminSession,
} from "@/lib/adminSession";
import {
  ADMIN_SESSION_INVALIDATED_EVENT,
  apiRequest,
} from "@/lib/queryClient";
import {
  DEFAULT_ADMIN_SESSION_POLICY,
  type AdminSessionPolicy,
} from "@shared/utils/adminSessionPolicy";

type AdminContextType = {
  isAdmin: boolean;
  permissionLevel: AdminPermissionLevel | null;
  isSuperAdmin: boolean;
  hasPermission: (requiredLevel: AdminPermissionLevel) => boolean;
  verifyPin: (pin: string, requiredLevel?: AdminPermissionLevel) => Promise<boolean>;
  elevatePin: (pin: string) => Promise<boolean>;
  logout: () => Promise<void>;
  updatePin: (oldPin: string, newPin: string) => Promise<boolean>;
  resetIdleTimer: () => void;
};

type ClearAdminStateOptions = {
  showToast?: boolean;
  title?: string;
  description?: string;
};

const AdminContext = createContext<AdminContextType | undefined>(undefined);

function getPermissionLevelFromPayload(payload: unknown): AdminPermissionLevel | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  return resolvePermissionLevel((payload as { permissionLevel?: unknown }).permissionLevel);
}

export function AdminProvider({ children }: { children: ReactNode }) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [permissionLevel, setPermissionLevel] = useState<AdminPermissionLevel | null>(null);
  const idleTimerRef = useRef<NodeJS.Timeout | null>(null);
  const heartbeatTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const lastSessionRefreshRef = useRef<number>(0);
  const isAdminRef = useRef(false);
  const sessionPolicyRef = useRef<AdminSessionPolicy>(DEFAULT_ADMIN_SESSION_POLICY);
  const sessionRefreshInFlightRef = useRef(false);
  const queryClient = useQueryClient();

  const clearLegacyAdminStorage = useCallback(() => {
    localStorage.removeItem("isAdmin");
    localStorage.removeItem("adminLoginTime");
    localStorage.removeItem("adminPin");
  }, []);

  const clearAdminQueries = useCallback(() => {
    const adminQueryPrefixes = [
      "/api/attendance",
      "/api/holidays",
      "/api/employees/admin",
      "/api/salary-records",
      "/api/settings/admin",
      "/api/db-status",
      "/api/supabase-config",
      "/api/supabase-connection",
      "/api/line/pending-bindings",
    ];

    queryClient.removeQueries({
      predicate: (query) => {
        const key = query.queryKey[0];
        return (
          typeof key === "string" &&
          adminQueryPrefixes.some((prefix) => key.startsWith(prefix))
        );
      },
    });
  }, [queryClient]);

  const syncAuthorizationState = useCallback((authenticated: boolean, payload?: unknown) => {
    setIsAdmin(authenticated);
    setPermissionLevel(authenticated ? getPermissionLevelFromPayload(payload) : null);
    isAdminRef.current = authenticated;
  }, []);

  const clearAdminState = useCallback((options?: ClearAdminStateOptions) => {
    syncAuthorizationState(false);
    clearLegacyAdminStorage();
    clearAdminQueries();

    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }

    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }

    sessionPolicyRef.current = DEFAULT_ADMIN_SESSION_POLICY;
    lastSessionRefreshRef.current = 0;
    sessionRefreshInFlightRef.current = false;

    if (options?.showToast) {
      toast({
        title: options.title || "已登出管理員模式",
        description: options.description || "管理員工作階段已結束，相關保護資料也已清除。",
      });
    }
  }, [clearAdminQueries, clearLegacyAdminStorage, syncAuthorizationState]);

  const applySessionPolicy = useCallback((payload: unknown) => {
    const nextPolicy = resolveAdminSessionPolicy(payload);
    sessionPolicyRef.current = nextPolicy;
    return nextPolicy;
  }, []);

  const syncAdminSession = useCallback(async () => {
    clearLegacyAdminStorage();

    try {
      const response = await fetch("/api/admin/session", {
        method: "GET",
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(`Unable to restore admin session: ${response.status}`);
      }

      const result = await response.json();
      applySessionPolicy(result);
      const authenticated = result?.isAdmin === true;

      syncAuthorizationState(authenticated, result);

      if (authenticated) {
        const now = Date.now();
        lastActivityRef.current = now;
        lastSessionRefreshRef.current = now;
      } else {
        clearAdminState();
      }

      return authenticated;
    } catch (error) {
      console.error("Admin session restore error:", error);
      clearAdminState();
      return false;
    }
  }, [applySessionPolicy, clearAdminState, clearLegacyAdminStorage, syncAuthorizationState]);

  const logout = useCallback(async (options?: ClearAdminStateOptions) => {
    try {
      await fetch("/api/admin/logout", {
        method: "POST",
        credentials: "include",
      });
    } catch (error) {
      console.error("Admin logout error:", error);
    } finally {
      clearAdminState(options);
    }
  }, [clearAdminState]);

  const refreshActiveSession = useCallback(async () => {
    if (!isAdminRef.current || sessionRefreshInFlightRef.current) {
      return false;
    }

    sessionRefreshInFlightRef.current = true;

    try {
      const response = await fetch("/api/admin/session", {
        method: "GET",
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(`Unable to refresh admin session: ${response.status}`);
      }

      const result = await response.json();
      applySessionPolicy(result);

      if (result?.isAdmin === true) {
        syncAuthorizationState(true, result);
        lastSessionRefreshRef.current = Date.now();
        return true;
      }

      clearAdminState({
        showToast: true,
        title: "管理員權限已失效",
        description: "管理員工作階段已過期，請重新登入後再繼續操作。",
      });
      return false;
    } catch (error) {
      console.error("Admin session heartbeat error:", error);
      return false;
    } finally {
      sessionRefreshInFlightRef.current = false;
    }
  }, [applySessionPolicy, clearAdminState, syncAuthorizationState]);

  const resetIdleTimer = useCallback(() => {
    if (!isAdminRef.current) {
      return;
    }

    lastActivityRef.current = Date.now();

    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
    }

    const { timeoutMinutes, timeoutMs } = sessionPolicyRef.current;

    idleTimerRef.current = setTimeout(() => {
      if (
        isAdminSessionIdleExpired({
          now: Date.now(),
          lastActivityAt: lastActivityRef.current,
          timeoutMs: sessionPolicyRef.current.timeoutMs,
        })
      ) {
        void logout({
          showToast: true,
          title: "管理員已自動登出",
          description: `超過 ${timeoutMinutes} 分鐘未操作，系統已自動結束管理員工作階段。`,
        });
      }
    }, timeoutMs);
  }, [logout]);

  useEffect(() => {
    if (!isAdmin) {
      return;
    }

    resetIdleTimer();

    const handleActivity = () => resetIdleTimer();
    window.addEventListener("mousemove", handleActivity);
    window.addEventListener("mousedown", handleActivity);
    window.addEventListener("keypress", handleActivity);
    window.addEventListener("touchmove", handleActivity);
    window.addEventListener("touchstart", handleActivity);
    window.addEventListener("scroll", handleActivity);

    return () => {
      window.removeEventListener("mousemove", handleActivity);
      window.removeEventListener("mousedown", handleActivity);
      window.removeEventListener("keypress", handleActivity);
      window.removeEventListener("touchmove", handleActivity);
      window.removeEventListener("touchstart", handleActivity);
      window.removeEventListener("scroll", handleActivity);

      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
  }, [isAdmin, resetIdleTimer]);

  useEffect(() => {
    if (!isAdmin) {
      return;
    }

    const heartbeatIntervalMs = 60 * 1000;

    heartbeatTimerRef.current = setInterval(() => {
      const { timeoutMs, refreshIntervalMs } = sessionPolicyRef.current;

      if (
        shouldRefreshAdminSession({
          now: Date.now(),
          lastActivityAt: lastActivityRef.current,
          lastRefreshAt: lastSessionRefreshRef.current,
          timeoutMs,
          refreshIntervalMs,
        })
      ) {
        void refreshActiveSession();
      }
    }, heartbeatIntervalMs);

    return () => {
      if (heartbeatTimerRef.current) {
        clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
    };
  }, [isAdmin, refreshActiveSession]);

  useEffect(() => {
    void syncAdminSession();
  }, [syncAdminSession]);

  useEffect(() => {
    isAdminRef.current = isAdmin;
  }, [isAdmin]);

  useEffect(() => {
    const handleSessionInvalidated = () => {
      if (isAdminRef.current) {
        clearAdminState({
          showToast: true,
          title: "管理員權限已失效",
          description: "管理員工作階段已過期，請重新登入後再繼續操作。",
        });
        return;
      }

      clearAdminState();
    };

    window.addEventListener(ADMIN_SESSION_INVALIDATED_EVENT, handleSessionInvalidated);
    return () => {
      window.removeEventListener(ADMIN_SESSION_INVALIDATED_EVENT, handleSessionInvalidated);
    };
  }, [clearAdminState]);

  const verifyPin = useCallback(async (
    pin: string,
    requiredLevel: AdminPermissionLevel = AdminPermissionLevel.ADMIN
  ): Promise<boolean> => {
    try {
      const endpoint =
        requiredLevel >= AdminPermissionLevel.SUPER
          ? "/api/admin/elevate-super"
          : "/api/verify-admin";

      const response = await apiRequest("POST", endpoint, { pin });
      const result = await response.json();

      if (result.success) {
        applySessionPolicy(result);
        syncAuthorizationState(true, result);
        const now = Date.now();
        lastActivityRef.current = now;
        lastSessionRefreshRef.current = now;
        return true;
      }

      toast({
        title: "驗證失敗",
        description:
          requiredLevel >= AdminPermissionLevel.SUPER
            ? "Super 管理員 PIN 不正確。"
            : "管理員或 Super 管理員 PIN 不正確。",
        variant: "destructive",
      });
      return false;
    } catch (error) {
      console.error("Admin verification error:", error);
      toast({
        title: "驗證發生錯誤",
        description:
          requiredLevel >= AdminPermissionLevel.SUPER
            ? "無法驗證 Super 管理員 PIN，請稍後再試。"
            : "無法驗證管理員或 Super 管理員 PIN，請稍後再試。",
        variant: "destructive",
      });
      return false;
    }
  }, [applySessionPolicy, syncAuthorizationState]);

  const elevatePin = useCallback(async (pin: string): Promise<boolean> => {
    return verifyPin(pin, AdminPermissionLevel.SUPER);
  }, [verifyPin]);

  const updatePin = async (oldPin: string, newPin: string): Promise<boolean> => {
    try {
      const response = await apiRequest("POST", "/api/update-admin-pin", { oldPin, newPin });
      const result = await response.json();

      if (result.success) {
        toast({
          title: "PIN 已更新",
          description: "管理員 PIN 已成功變更。",
        });
        return true;
      }

      toast({
        title: "更新 PIN 失敗",
        description: result.message || "無法更新管理員 PIN。",
        variant: "destructive",
      });
      return false;
    } catch (error) {
      console.error("Admin pin update error:", error);
      toast({
        title: "更新 PIN 發生錯誤",
        description: "請稍後再試一次。",
        variant: "destructive",
      });
      return false;
    }
  };

  const hasPermission = useCallback((requiredLevel: AdminPermissionLevel) => {
    return hasPermissionLevel(permissionLevel, requiredLevel);
  }, [permissionLevel]);

  const isSuperAdmin = hasPermission(AdminPermissionLevel.SUPER);

  return (
    <AdminContext.Provider
      value={{
        isAdmin,
        permissionLevel,
        isSuperAdmin,
        hasPermission,
        verifyPin,
        elevatePin,
        logout,
        updatePin,
        resetIdleTimer,
      }}
    >
      {children}
    </AdminContext.Provider>
  );
}

export function useAdmin() {
  const context = useContext(AdminContext);
  if (!context) {
    throw new Error("useAdmin must be used within an AdminProvider");
  }
  return context;
}
