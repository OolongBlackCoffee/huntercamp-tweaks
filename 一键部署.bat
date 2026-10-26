@echo off
setlocal
cd /d "%~dp0"
title HUNTER CAMP 一键部署
echo ================================================
echo    HUNTER CAMP 一键部署（软件升级/覆盖安装后用）
echo ================================================
echo.
echo   将要恢复的改动：
echo     1. 首页「触控板」卡片（与深度优化联动）
echo     2. 首页「显卡降压」卡片 + 本机降频服务
echo     3. 彻底隐藏「逗逗陪玩」
echo.
echo   下一步会弹 UAC 请求管理员权限，请点「是」。
echo.
pause
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1"
exit /b