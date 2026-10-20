@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist config.json (
    echo Chưa tìm thấy config.json!
    echo Đang tạo config.json từ mẫu...
    copy config.example.json config.json >nul
    echo Đã tạo file config.json. Hãy mở file và điền ID nhóm vào groupIds!
    notepad config.json
    pause
    exit /b
)
echo ===================================================
echo [Zalo Link Guard] Khởi động Bot lọc link Zalo
echo ===================================================
call npm start
pause
