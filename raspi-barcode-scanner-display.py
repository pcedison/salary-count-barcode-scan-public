#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Raspberry Pi 條碼掃描器 - 帶 3.5 吋螢幕顯示功能
用於與員工考勤系統集成的 USB 條碼掃描器和螢幕顯示腳本

功能:
1. 監聽 USB 掃碼槍輸入
2. 通過 API 發送到伺服器
3. 在 3.5 吋 LCD 上顯示打卡結果和待機時鐘
4. 提供離線緩存功能，確保網絡問題時不丟失數據

使用方法:
1. 安裝必要套件:
   - sudo apt-get update
   - sudo apt-get install python3-pip python3-pil python3-numpy fonts-noto-cjk libopenjp2-7
   - sudo pip3 install RPi.GPIO requests Pillow
2. 編輯配置部分以匹配您的系統設置
3. 運行腳本: python3 raspi-barcode-scanner-display.py
4. 使用掃碼槍掃描員工條碼

注意: 此腳本使用 framebuffer 直接繪製到螢幕，無需 X Window
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
import signal
from datetime import datetime
from PIL import Image, ImageDraw, ImageFont
import numpy as np

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
INPUT_TIMEOUT = 0.5     # 輸入超時 (秒)
SCAN_DISPLAY_TIME = 6   # 打卡成功顯示時間 (秒)
CLOCK_UPDATE_INTERVAL = 1 # 待機時鐘更新間隔 (秒)

# 離線緩存配置
CACHE_DIR = "/home/pi/barcode_cache"  # 離線緩存目錄
MAX_CACHE_SIZE = 1000                 # 最大緩存記錄數

# 日誌配置
LOG_FILE = "/home/pi/barcode_scanner.log"  # 日誌文件路徑
LOG_LEVEL = logging.INFO                   # 日誌級別

# 螢幕顯示配置
FRAMEBUFFER_DEVICE = "/dev/fb0"  # 默認 framebuffer 設備
SCREEN_WIDTH = 480               # 3.5 吋螢幕的寬度
SCREEN_HEIGHT = 320              # 3.5 吋螢幕的高度
FONT_PATH = "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc"  # 中文字體路徑
FONT_SIZE = 40                   # 字體大小，按照需求設定
CLOCK_FONT_SIZE = 50             # 待機時鐘字體大小

# 顯示顏色配置
CLOCK_BG_COLOR = (0, 0, 0)          # 待機時鐘背景顏色 (黑色)
CLOCK_TEXT_COLOR = (255, 255, 255)  # 待機時鐘文字顏色 (白色)
CHECKIN_BG_COLOR = (0, 187, 0)      # 上班打卡背景顏色 (綠色 #00BB00)
CHECKOUT_BG_COLOR = (106, 106, 255) # 下班打卡背景顏色 (紫色 #6A6AFF)
SUCCESS_TEXT_COLOR = (255, 255, 255) # 成功提示文字顏色 (白色)

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
display_queue = queue.Queue()
stop_event = threading.Event()

# 預載字體
try:
    font = ImageFont.truetype(FONT_PATH, FONT_SIZE)
    clock_font = ImageFont.truetype(FONT_PATH, CLOCK_FONT_SIZE)
    logger.info("Fonts loaded successfully")
except Exception as e:
    logger.error(f"Failed to load fonts: {e}")
    # 使用默認字體作為備選
    font = ImageFont.load_default()
    clock_font = ImageFont.load_default()

# 初始化 framebuffer
try:
    fb = open(FRAMEBUFFER_DEVICE, 'wb')
    logger.info(f"Framebuffer device {FRAMEBUFFER_DEVICE} opened successfully")
except Exception as e:
    logger.error(f"Failed to open framebuffer device: {e}")
    sys.exit(1)

# ======= 功能實現 =======
def update_screen(image):
    """將 PIL 圖像更新到 framebuffer"""
    try:
        fb_data = image.convert('RGB').tobytes()
        fb.seek(0)
        fb.write(fb_data)
        fb.flush()
    except Exception as e:
        logger.error(f"Failed to update screen: {e}")

def draw_clock():
    """繪製待機時鐘"""
    now = datetime.now()
    time_str = now.strftime('%H:%M:%S')
    date_str = now.strftime('%Y/%m/%d')

    # 創建黑色背景圖像
    image = Image.new('RGB', (SCREEN_WIDTH, SCREEN_HEIGHT), CLOCK_BG_COLOR)
    draw = ImageDraw.Draw(image)

    # 繪製時間
    time_width, time_height = draw.textsize(time_str, font=clock_font)
    time_position = ((SCREEN_WIDTH - time_width) // 2, (SCREEN_HEIGHT - time_height) // 2 - 30)
    draw.text(time_position, time_str, fill=CLOCK_TEXT_COLOR, font=clock_font)

    # 繪製日期
    date_width, date_height = draw.textsize(date_str, font=font)
    date_position = ((SCREEN_WIDTH - date_width) // 2, time_position[1] + time_height + 20)
    draw.text(date_position, date_str, fill=CLOCK_TEXT_COLOR, font=font)

    return image

def draw_success_screen(action, name, time_str, date_str):
    """繪製打卡成功畫面"""
    # 根據打卡類型選擇背景顏色
    bg_color = CHECKIN_BG_COLOR if action == 'clock-in' else CHECKOUT_BG_COLOR

    # 創建背景圖像
    image = Image.new('RGB', (SCREEN_WIDTH, SCREEN_HEIGHT), bg_color)
    draw = ImageDraw.Draw(image)

    # 設置標題文字
    title = "上班時間" if action == 'clock-in' else "下班時間"

    # 繪製標題
    title_width, title_height = draw.textsize(title, font=font)
    draw.text(((SCREEN_WIDTH - title_width) // 2, 40), title, fill=SUCCESS_TEXT_COLOR, font=font)

    # 繪製日期
    date_width, date_height = draw.textsize(date_str, font=font)
    draw.text(((SCREEN_WIDTH - date_width) // 2, 100), date_str, fill=SUCCESS_TEXT_COLOR, font=font)

    # 繪製時間
    time_width, time_height = draw.textsize(time_str, font=font)
    draw.text(((SCREEN_WIDTH - time_width) // 2, 160), time_str, fill=SUCCESS_TEXT_COLOR, font=font)

    # 繪製成功訊息
    message = "打卡成功"
    msg_width, msg_height = draw.textsize(message, font=font)
    draw.text(((SCREEN_WIDTH - msg_width) // 2, 220), message, fill=SUCCESS_TEXT_COLOR, font=font)

    # 如果有員工姓名，則顯示
    if name:
        name_width, name_height = draw.textsize(name, font=font)
        draw.text(((SCREEN_WIDTH - name_width) // 2, SCREEN_HEIGHT - name_height - 40), name, fill=SUCCESS_TEXT_COLOR, font=font)

    return image

def signal_success():
    """成功時提供 LED 和蜂鳴器反饋"""
    if USE_GPIO:
        # 閃爍綠色 LED
        GPIO.output(SUCCESS_LED_PIN, GPIO.HIGH)
        GPIO.output(BUZZER_PIN, GPIO.HIGH)
        time.sleep(0.1)
        GPIO.output(BUZZER_PIN, GPIO.LOW)
        time.sleep(0.8)
        GPIO.output(SUCCESS_LED_PIN, GPIO.LOW)

def signal_error():
    """錯誤時提供 LED 和蜂鳴器反饋"""
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

        now = datetime.now()
        current_date = now.strftime("%Y/%m/%d")
        current_time = now.strftime("%H:%M")

        if response.status_code == 200:
            result = response.json()
            logger.info(f"Scan successful: {result}")
            signal_success()

            # 將成功結果發送到顯示隊列
            if result.get('success'):
                action = result.get('action', 'clock-in')
                name = result.get('name', '')

                # 將結果發送到顯示隊列
                display_queue.put({
                    'type': 'success',
                    'action': action,
                    'name': name,
                    'date': current_date,
                    'time': current_time,
                    'duration': SCAN_DISPLAY_TIME
                })
            else:
                # 錯誤結果，顯示錯誤信息
                display_queue.put({
                    'type': 'error',
                    'message': result.get('message', '未知錯誤'),
                    'code': result.get('code', 'UNKNOWN_ERROR'),
                    'duration': SCAN_DISPLAY_TIME
                })
        else:
            logger.error(f"Scan failed: HTTP {response.status_code}")
            signal_error()

            # 將錯誤結果發送到顯示隊列
            display_queue.put({
                'type': 'error',
                'message': f"伺服器錯誤 ({response.status_code})",
                'code': f"HTTP_{response.status_code}",
                'duration': SCAN_DISPLAY_TIME
            })

    except requests.RequestException as e:
        logger.error(f"Network error during scan: {e}")

        # 緩存掃描數據以便稍後處理
        cached = cache_scan(barcode)

        # 將網絡錯誤結果發送到顯示隊列
        display_queue.put({
            'type': 'error',
            'message': "網絡連接失敗" + (", 已將打卡緩存" if cached else ""),
            'code': "NETWORK_ERROR",
            'duration': SCAN_DISPLAY_TIME
        })
        signal_error()

    except Exception as e:
        logger.error(f"Unexpected error during scan: {e}")

        # 將意外錯誤結果發送到顯示隊列
        display_queue.put({
            'type': 'error',
            'message': f"處理錯誤: {str(e)}",
            'code': "UNEXPECTED_ERROR",
            'duration': SCAN_DISPLAY_TIME
        })
        signal_error()

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

def display_thread():
    """處理顯示隊列的線程"""
    is_showing_clock = True
    last_clock_update = 0
    current_display_end_time = 0

    while not stop_event.is_set():
        try:
            now = time.time()

            # 檢查是否有新的顯示請求
            try:
                display_request = display_queue.get_nowait()

                # 取得顯示請求，更新屏幕
                if display_request['type'] == 'success':
                    image = draw_success_screen(
                        display_request['action'],
                        display_request['name'],
                        display_request['time'],
                        display_request['date']
                    )
                    update_screen(image)
                    is_showing_clock = False
                    current_display_end_time = now + display_request['duration']

                elif display_request['type'] == 'error':
                    # 這裡可以添加錯誤畫面的顯示代碼
                    # 目前先使用時鐘畫面
                    image = draw_clock()
                    update_screen(image)
                    is_showing_clock = True

                display_queue.task_done()

            except queue.Empty:
                # 沒有新的顯示請求

                # 檢查當前顯示是否應該結束
                if not is_showing_clock and now > current_display_end_time:
                    is_showing_clock = True

                # 如果是顯示時鐘模式，並且時間到了更新間隔，則更新時鐘
                if is_showing_clock and (now - last_clock_update) >= CLOCK_UPDATE_INTERVAL:
                    image = draw_clock()
                    update_screen(image)
                    last_clock_update = now

        except Exception as e:
            logger.error(f"Error in display thread: {e}")

        time.sleep(0.1)

def cleanup():
    """清理資源"""
    stop_event.set()

    if USE_GPIO:
        GPIO.cleanup()

    try:
        fb.close()
    except:
        pass

    logger.info("Application shutdown complete")

def signal_handler(sig, frame):
    """處理中斷信號"""
    logger.info("Interrupt received, shutting down...")
    cleanup()
    sys.exit(0)

def main():
    """主函數"""
    # 註冊信號處理器，以便優雅地處理中斷
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    logger.info("Starting barcode scanner application with display")

    # 啟動處理線程
    processor = threading.Thread(target=processing_thread)
    processor.daemon = True
    processor.start()

    # 啟動顯示線程
    display_proc = threading.Thread(target=display_thread)
    display_proc.daemon = True
    display_proc.start()

    # 初始顯示時鐘
    display_queue.put({
        'type': 'clock',
        'duration': 0
    })

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
        cleanup()

if __name__ == "__main__":
    # 處理直接運行
    try:
        import select
        main()
    except ImportError:
        logger.critical("Required module 'select' not found")
        print("ERROR: Required module 'select' not found")
        print("Please install all dependencies: pip install requests Pillow numpy")
        sys.exit(1)