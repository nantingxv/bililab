@echo off
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
if defined BILILAB_PYTHON (set "PY=%BILILAB_PYTHON%") else (set "PY=python")
set BILI_OPEN=1
echo [BiliLab] 启动中…… 浏览器会自动打开 http://127.0.0.1:8765
"%PY%" "%HERE%server.py"
if errorlevel 1 pause
