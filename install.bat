@echo off
chcp 65001 >nul
title 网课助手 一键部署
set "PS1=%~dp0install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; iex ([IO.File]::ReadAllText('%PS1%',[Text.Encoding]::UTF8))"
echo.
echo 安装结束。若窗口一闪而过，请看 INSTALL.md 里的手动步骤。
pause
