@echo off
setlocal
cd /d "%~dp0"
title HUNTER CAMP 还原
echo ================================================
echo    HUNTER CAMP 还原（回到官方原状）
echo ================================================
echo.
echo   会删除三张卡片的注入、移除降频服务与计划任务，
echo   并让「逗逗陪玩」重新可用。
echo.
echo   下一步会弹 UAC 请求管理员权限，请点「是」。
echo.
pause
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" -Restore
exit /b