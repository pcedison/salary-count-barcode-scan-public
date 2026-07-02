import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

import { calculateOvertime as sharedCalculateOvertime } from '@shared/utils/salaryMath';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Format date as YYYY/MM/DD
export function formatDate(dateStr: string): string {
  if (!dateStr) return '';

  // If already in YYYY/MM/DD format, return as is
  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(dateStr)) {
    return dateStr;
  }

  try {
    const date = new Date(dateStr.replace(/\//g, '-'));
    if (isNaN(date.getTime())) return dateStr;

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return `${year}/${month}/${day}`;
  } catch (e) {
    console.error('Error formatting date:', e);
    return dateStr;
  }
}


// Calculate overtime hours based on clock-in and clock-out times
// OT1 加班時間範圍（16:00-18:10）：
// 1. 16:10 前，加班 0 小時
// 2. 16:10 - 16:35，加班 0.5 小時
// 3. 16:36 - 17:10，加班 1 小時
// 4. 17:11 - 17:35，加班 1.5 小時
// 5. 17:36 - 18:10，加班 2 小時
export function calculateOvertime(clockIn: string, clockOut: string): {
  ot1: number; // First phase overtime (1.34x)
  ot2: number; // Second phase overtime (1.67x)
  total: number; // Total hours worked
} {
  return sharedCalculateOvertime(clockIn, clockOut);
}

// Format currency to show with commas
export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('zh-TW').format(amount);
}

// Get month name from numeric month
export function getMonthName(month: number): string {
  return `${month}月`;
}

// Get the current year and month
export function getCurrentYearMonth(): { year: number; month: number } {
  const now = new Date();
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1
  };
}

// Get the current time in HH:MM format (Taiwan time UTC+8)
export function getCurrentTime(): string {
  // 使用台灣時區 (UTC+8)
  const now = new Date();
  const taiwanTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const hours = String(taiwanTime.getUTCHours()).padStart(2, '0');
  const minutes = String(taiwanTime.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

// Get today's date in YYYY/MM/DD format (Taiwan time UTC+8)
export function getTodayDate(): string {
  // 使用台灣時區 (UTC+8)
  const now = new Date();
  const taiwanTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const year = taiwanTime.getUTCFullYear();
  const month = String(taiwanTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(taiwanTime.getUTCDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}
