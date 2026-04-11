import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAdmin } from "@/hooks/useAdmin";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import {
  DEFAULT_ADMIN_SETTINGS,
  DEFAULT_PUBLIC_SETTINGS,
  toAdminSettingsPayload,
  toPublicSettingsPayload,
  type AdminSettingsPayload,
  type PublicSettingsPayload,
} from "@shared/settings";

type UseSettingsOptions = {
  requireAdminSettings?: boolean;
};

export function useSettings(options: UseSettingsOptions = {}) {
  const { requireAdminSettings = false } = options;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { isAdmin } = useAdmin();
  const needsAdminSettings = requireAdminSettings && isAdmin;

  const {
    data: publicSettings,
    isLoading: isPublicSettingsLoading,
    error: publicSettingsError,
  } = useQuery<PublicSettingsPayload>({
    queryKey: ["/api/settings"],
  });

  const {
    data: adminSettings,
    isLoading: isAdminSettingsLoading,
    error: adminSettingsError,
  } = useQuery<AdminSettingsPayload | null>({
    queryKey: ["/api/settings/admin"],
    enabled: needsAdminSettings,
    queryFn: getQueryFn({ on401: "returnNull" }),
  });

  const updateSettingsMutation = useMutation({
    mutationFn: async (newSettings: AdminSettingsPayload) => {
      return apiRequest("POST", "/api/settings", newSettings);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/settings/admin"] });
    },
    onError: (error) => {
      console.error("Error updating settings:", error);
      toast({
        title: "設定儲存失敗",
        description: "無法儲存薪資設定，請稍後再試。",
        variant: "destructive",
      });
    },
  });

  const {
    data: holidays = [],
    isLoading: isHolidaysLoading,
  } = useQuery({
    queryKey: ["/api/holidays"],
    enabled: isAdmin,
  });

  const addHolidayMutation = useMutation({
    mutationFn: async (holiday: {
      employeeId: number;
      date: string;
      name: string;
      holidayType:
        | "worked"
        | "sick_leave"
        | "personal_leave"
        | "national_holiday"
        | "typhoon_leave"
        | "special_leave";
      description?: string;
    }) => {
      return apiRequest("POST", "/api/holidays", holiday);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/holidays"] });
    },
    onError: (error) => {
      console.error("Error adding holiday:", error);
      toast({
        title: "假日新增失敗",
        description: "無法新增假日設定，請稍後再試。",
        variant: "destructive",
      });
    },
  });

  const deleteHolidayMutation = useMutation({
    mutationFn: async (id: number) => {
      try {
        return await apiRequest("DELETE", `/api/holidays/${id}`);
      } catch (error: any) {
        if (typeof error?.message === "string" && error.message.startsWith("404")) {
          return null;
        }

        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/holidays"] });
      queryClient.invalidateQueries({ queryKey: ["/api/attendance"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees/admin"] });
    },
    onError: (error) => {
      console.error("Error deleting holiday:", error);
      toast({
        title: "假日刪除失敗",
        description: "無法刪除假日設定，請稍後再試。",
        variant: "destructive",
      });
    },
  });

  useEffect(() => {
    if (!publicSettingsError) {
      return;
    }

    console.error("Error fetching public settings:", publicSettingsError);
    toast({
      title: "設定載入失敗",
      description: "無法取得公開設定，請重新整理後再試。",
      variant: "destructive",
    });
  }, [publicSettingsError, toast]);

  useEffect(() => {
    if (!needsAdminSettings || !adminSettingsError) {
      return;
    }

    console.error("Error fetching admin settings:", adminSettingsError);
    toast({
      title: "管理設定載入失敗",
      description: "無法取得完整薪資設定，請重新登入或稍後再試。",
      variant: "destructive",
    });
  }, [adminSettingsError, needsAdminSettings, toast]);

  const updateSettings = async (newSettings: AdminSettingsPayload) => {
    try {
      await updateSettingsMutation.mutateAsync(newSettings);
      return true;
    } catch {
      return false;
    }
  };

  const addHoliday = async (holiday: {
    employeeId: number;
    date: string;
    name: string;
    holidayType:
      | "worked"
      | "sick_leave"
      | "personal_leave"
      | "national_holiday"
      | "typhoon_leave"
      | "special_leave";
    description?: string;
  }) => {
    try {
      await addHolidayMutation.mutateAsync(holiday);
      return true;
    } catch {
      return false;
    }
  };

  const deleteHoliday = async (id: number) => {
    try {
      await deleteHolidayMutation.mutateAsync(id);
      return true;
    } catch {
      return false;
    }
  };

  const mergedPublicSettings = toPublicSettingsPayload(
    publicSettings ?? DEFAULT_PUBLIC_SETTINGS,
  );

  return {
    settings: needsAdminSettings
      ? adminSettings
        ? toAdminSettingsPayload(adminSettings)
        : null
      : toAdminSettingsPayload(mergedPublicSettings),
    publicSettings: mergedPublicSettings,
    adminSettings: adminSettings
      ? toAdminSettingsPayload(adminSettings)
      : null,
    barcodeEnabled: mergedPublicSettings.barcodeEnabled,
    isLoading:
      isPublicSettingsLoading || (needsAdminSettings && isAdminSettingsLoading),
    updateSettings,
    holidays,
    isHolidaysLoading,
    addHoliday,
    deleteHoliday,
    defaults: DEFAULT_ADMIN_SETTINGS,
  };
}
