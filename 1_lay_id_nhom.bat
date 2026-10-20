@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ===================================================
echo [Zalo Link Guard] Quét mã QR để lấy danh sách nhóm
echo ===================================================
call npm start -- --list-groups
pause
