@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title 天氣 - 欄位選擇

where py >nul 2>nul
if not errorlevel 1 (
    py -3 -X utf8 "資料規劃\欄位選擇\server.py" --open-browser
    if errorlevel 1 goto launch_failed
    exit /b 0
)

where python >nul 2>nul
if errorlevel 1 goto python_missing
python -X utf8 "資料規劃\欄位選擇\server.py" --open-browser
if errorlevel 1 goto launch_failed
exit /b 0

:python_missing
echo 找不到 Python 3，請先安裝 Python 3 後再試。
pause
exit /b 1

:launch_failed
echo.
echo 啟動失敗，請保留上方錯誤訊息以便檢查。
pause
exit /b 1
