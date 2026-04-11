#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Raspberry Pi 輕量級條碼掃描器
用於與員工考勤系統集成的 USB 條碼掃描器腳本

功能:
1. 監聽 USB 掃碼槍輸入
2. 通過 API 發送到伺服器
3. 處理回應並顯示結果
4. 提供離線緩存功能，確保網絡問題時不丟失數據

使用方法:
1. 安裝必要套件: pip install requests
2. 編輯配置部分以匹配您的系統設置
3. 運行腳本: python raspi-barcode-scanner.py
4. 使用掃碼槍掃描員工條碼

注意: 此腳本專為 Raspberry Pi OS Lite 設計，無 GUI，僅通過 CLI 和 LED/蜂鳴器提供反饋
"""

import sys
import time
import json
import os
import threading
import subprocess
import requests
import queue
import logging
from datetime import datetime

# ======= 配置部分 (請根據您的需求修改) =======
# 服務器 API 配置
API_SERVER = "http://your-server-ip:5000"  # 修改為您的伺服器 IP 地址
API_ENDPOINT = "/api/raspberry-scan"       # 我們剛剛創建的 API 端點
DEVICE_ID = "raspberrypi01"                # 為此設備分配一個唯一 ID

# GPIO 配置 (可選)
# 如果您想要使用 GPIO 控制 LED 和蜂鳴器作為視覺和聲音提示
USE_GPIO = False  # 如果您不想使用 GPIO，設為 False

# GPIO 針腳定義 (BCM 模式)
SUCCESS_LED_PIN = 17   # 綠色 LED (成功)
ERROR_LED_PIN = 27     # 紅色 LED (錯誤)
BUZZER_PIN = 22        # 蜂鳴器針腳

# 輸入和掃描配置
INPUT_TIMEOUT = 0.5    # 輸入超時 (秒)
SCAN_DISPLAY_TIME = 3  # 顯示結果的時間 (秒)

# 離線緩存配置
CACHE_DIR = "/home/pi/barcode_cache"  # 離線緩存目錄
MAX_CACHE_SIZE = 1000                  # 最大緩存記錄數

# 日誌配置
LOG_FILE = "/home/pi/barcode_scanner.log"  # 日誌文件路徑
LOG_LEVEL = logging.INFO                   # 日誌級別

# ======= 初始化 =======
logger = logging.getLogger("barcode_scanner")
logger.setLevel(LOG_LEVEL)

# 創建一個文件處理器
file_handler = logging.FileHandler(LOG_FILE)
file_handler.setLevel(LOG_LEVEL)

# 創建一個控制台處理器
console_handler = logging.StreamHandler()
console_handler.setLevel(LOG_LEVEL)

# 創建格式化器並添加到處理器
formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
file_handler.setFormatter(formatter)
console_handler.setFormatter(formatter)

# 添加處理器到記錄器
logger.addHandler(file_handler)
logger.addHandler(console_handler)

# 初始化 GPIO (可選)
if USE_GPIO:
    try:
        import RPi.GPIO as GPIO
        GPIO.setmode(GPIO.BCM)
        GPIO.setup(SUCCESS_LED_PIN, GPIO.OUT)
        GPIO.setup(ERROR_LED_PIN, GPIO.OUT)
        GPIO.setup(BUZZER_PIN, GPIO.OUT)
        GPIO.output(SUCCESS_LED_PIN, GPIO.LOW)
        GPIO.output(ERROR_LED_PIN, GPIO.LOW)
        GPIO.output(BUZZER_PIN, GPIO.LOW)
        logger.info("GPIO initialized successfully")
    except ImportError:
        logger.warning("RPi.GPIO module not found. LED/Buzzer feedback disabled.")
        USE_GPIO = False
    except Exception as e:
        logger.error(f"GPIO initialization error: {e}")
        USE_GPIO = False

# 確保緩存目錄存在
if not os.path.exists(CACHE_DIR):
    os.makedirs(CACHE_DIR)
    logger.info(f"Created cache directory: {CACHE_DIR}")

# 掃描隊列和處理線程
scan_queue = queue.Queue()
stop_event = threading.Event()

# ======= 功能實現 =======
def signal_success():
    """成功時提供反饋"""
    if USE_GPIO:
        # 閃爍綠色 LED
        GPIO.output(SUCCESS_LED_PIN, GPIO.HIGH)
        GPIO.output(BUZZER_PIN, GPIO.HIGH)
        time.sleep(0.1)
        GPIO.output(BUZZER_PIN, GPIO.LOW)
        time.sleep(0.8)
        GPIO.output(SUCCESS_LED_PIN, GPIO.LOW)
    else:
        # 使用控制台提供視覺反饋
        print("\033[92m" + "✓ 打卡成功" + "\033[0m")
        sys.stdout.flush()

def signal_error():
    """錯誤時提供反饋"""
    if USE_GPIO:
        # 閃爍紅色 LED 和蜂鳴
        for _ in range(3):
            GPIO.output(ERROR_LED_PIN, GPIO.HIGH)
            GPIO.output(BUZZER_PIN, GPIO.HIGH)
            time.sleep(0.1)
            GPIO.output(BUZZER_PIN, GPIO.LOW)
            time.sleep(0.1)
            GPIO.output(ERROR_LED_PIN, GPIO.LOW)
            time.sleep(0.1)
    else:
        # 使用控制台提供視覺反饋
        print("\033[91m" + "✗ 打卡失敗" + "\033[0m")
        sys.stdout.flush()

def clear_screen():
    """清除終端屏幕"""
    os.system('clear')

def display_header():
    """顯示應用程序標題"""
    clear_screen()
    print("=" * 50)
    print("  員工考勤系統 - 打卡終端")
    print("=" * 50)
    print(f"現在時間: {datetime.now().strftime('%Y/%m/%d %H:%M:%S')}")
    print("-" * 50)
    print("請掃描員工身份證或居留證條碼...")
    print("-" * 50)
    sys.stdout.flush()

def display_result(scan_result):
    """顯示掃描結果"""
    clear_screen()
    print("=" * 50)

    if scan_result.get('success'):
        action = "上班打卡" if scan_result.get('action') == 'clock-in' else "下班打卡"
        name = scan_result.get('name', '員工')
        department = scan_result.get('department', '')
        time = scan_result.get('time', datetime.now().strftime('%H:%M'))
        is_holiday = scan_result.get('isHoliday', False)

        print(f"  ✓ {action}成功!")
        print("=" * 50)
        print(f"員工: {name}")
        if department:
            print(f"部門: {department}")
        print(f"時間: {time}")

        if is_holiday:
            print("注意: 今天是假日")
    else:
        error_code = scan_result.get('code', 'UNKNOWN_ERROR')
        message = scan_result.get('message', '未知錯誤')

        print("  ✗ 打卡失敗!")
        print("=" * 50)
        print(f"錯誤: {message}")
        print(f"代碼: {error_code}")

    print("-" * 50)
    print(f"將在 {SCAN_DISPLAY_TIME} 秒後恢復掃描...")
    sys.stdout.flush()

def cache_scan(barcode):
    """在無法連接伺服器時緩存掃描數據"""
    timestamp = datetime.now().isoformat()
    cache_file = os.path.join(CACHE_DIR, f"scan_{timestamp.replace(':', '-')}.json")

    try:
        with open(cache_file, 'w') as f:
            json.dump({
                'idNumber': barcode,
                'timestamp': timestamp,
                'deviceId': DEVICE_ID
            }, f)
        logger.info(f"Cached scan data to {cache_file}")
        return True
    except Exception as e:
        logger.error(f"Failed to cache scan: {e}")
        return False

def send_cached_scans():
    """嘗試發送緩存的掃描數據"""
    cache_files = [f for f in os.listdir(CACHE_DIR) if f.startswith('scan_') and f.endswith('.json')]

    if not cache_files:
        return

    logger.info(f"Found {len(cache_files)} cached scans to process")

    for cache_file in cache_files:
        try:
            with open(os.path.join(CACHE_DIR, cache_file), 'r') as f:
                cached_data = json.load(f)

            response = requests.post(
                f"{API_SERVER}{API_ENDPOINT}",
                json=cached_data,
                timeout=5
            )

            if response.status_code == 200:
                logger.info(f"Successfully sent cached scan {cache_file}")
                os.remove(os.path.join(CACHE_DIR, cache_file))
            else:
                logger.warning(f"Failed to send cached scan {cache_file}: {response.status_code}")
        except Exception as e:
            logger.error(f"Error processing cached scan {cache_file}: {e}")

def process_barcode(barcode):
    """處理掃描的條碼數據"""
    if not barcode:
        return

    logger.info(f"Processing barcode: {barcode}")

    try:
        # 向伺服器發送掃描數據
        response = requests.post(
            f"{API_SERVER}{API_ENDPOINT}",
            json={
                'idNumber': barcode,
                'deviceId': DEVICE_ID
            },
            timeout=5
        )

        if response.status_code == 200:
            result = response.json()
            logger.info(f"Scan successful: {result}")
            signal_success()
            display_result(result)
            time.sleep(SCAN_DISPLAY_TIME)
            display_header()
        else:
            error_data = {
                'success': False,
                'code': f"HTTP_{response.status_code}",
                'message': response.text if response.text else "伺服器返回錯誤"
            }
            logger.error(f"Scan failed: {error_data}")
            signal_error()
            display_result(error_data)
            time.sleep(SCAN_DISPLAY_TIME)
            display_header()

    except requests.RequestException as e:
        logger.error(f"Network error during scan: {e}")

        # 緩存掃描數據以便稍後處理
        if cache_scan(barcode):
            error_data = {
                'success': False,
                'code': "NETWORK_ERROR",
                'message': "網絡連接失敗，已將打卡緩存"
            }
        else:
            error_data = {
                'success': False,
                'code': "CACHE_ERROR",
                'message': "網絡連接失敗，且緩存失敗"
            }

        signal_error()
        display_result(error_data)
        time.sleep(SCAN_DISPLAY_TIME)
        display_header()

    except Exception as e:
        logger.error(f"Unexpected error during scan: {e}")
        error_data = {
            'success': False,
            'code': "UNEXPECTED_ERROR",
            'message': str(e)
        }
        signal_error()
        display_result(error_data)
        time.sleep(SCAN_DISPLAY_TIME)
        display_header()

def processing_thread():
    """處理掃描隊列的線程"""
    while not stop_event.is_set():
        try:
            # 嘗試發送緩存的掃描數據
            send_cached_scans()

            # 處理新的掃描數據
            try:
                barcode = scan_queue.get(timeout=1)
                process_barcode(barcode)
                scan_queue.task_done()
            except queue.Empty:
                pass

        except Exception as e:
            logger.error(f"Error in processing thread: {e}")

        time.sleep(0.1)

def main():
    """主函數"""
    logger.info("Starting barcode scanner application")

    # 顯示歡迎屏幕
    display_header()

    # 啟動處理線程
    processor = threading.Thread(target=processing_thread)
    processor.daemon = True
    processor.start()

    # 主循環 - 從標準輸入讀取條碼
    current_input = ""
    last_input_time = time.time()

    try:
        while True:
            # 檢查是否有新輸入
            if sys.stdin.isatty() and sys.stdin in select.select([sys.stdin], [], [], 0)[0]:
                char = sys.stdin.read(1)

                # 更新最後輸入時間
                last_input_time = time.time()

                # 處理特殊鍵
                if char == '\n':
                    # 提交完整的條碼
                    if current_input:
                        scan_queue.put(current_input.strip())
                        current_input = ""
                else:
                    # 添加字符到當前輸入
                    current_input += char

            # 檢查輸入超時
            elif current_input and (time.time() - last_input_time > INPUT_TIMEOUT):
                # 自動提交超時的輸入
                scan_queue.put(current_input.strip())
                current_input = ""

            time.sleep(0.01)

    except KeyboardInterrupt:
        logger.info("Application terminated by user")
    finally:
        # 清理資源
        stop_event.set()
        if USE_GPIO:
            GPIO.cleanup()
        logger.info("Application shutdown complete")

if __name__ == "__main__":
    # 處理直接運行
    try:
        import select
        main()
    except ImportError:
        logger.critical("Required module 'select' not found")
        print("ERROR: Required module 'select' not found")
        print("Please install all dependencies: pip install requests")
        sys.exit(1)