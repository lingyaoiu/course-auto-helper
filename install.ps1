#requires -version 3
# 网课助手 一键部署脚本（Windows）
# 用法：irm https://gh-proxy.com/https://raw.githubusercontent.com/lingyaoiu/course-auto-helper/main/install.ps1 | iex

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

$Repo       = 'lingyaoiu/course-auto-helper'
$InstallDir = Join-Path $env:USERPROFILE 'CourseHelper'

function Step($t) { Write-Host "==> $t" -ForegroundColor Cyan }

Write-Host ""
Write-Host "  网课助手 一键部署" -ForegroundColor Green
Write-Host "  安装目录：$InstallDir" -ForegroundColor DarkGray
Write-Host ""

$zipUrl = 'https://github.com/' + $Repo + '/archive/refs/heads/main.zip'
$sources = @(
  ('https://gh-proxy.com/' + $zipUrl),
  $zipUrl,
  ('https://ghproxy.net/' + $zipUrl)
)

if (!(Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }

$zip = Join-Path $env:TEMP 'course-auto-helper.zip'
$downloaded = $false
foreach ($u in $sources) {
  try {
    Step "下载压缩包：$u"
    Invoke-WebRequest -Uri $u -OutFile $zip -UseBasicParsing -TimeoutSec 90
    if ((Get-Item $zip).Length -gt 100000) { $downloaded = $true; break }
  } catch {
    Write-Host "    这个源不行，换下一个…" -ForegroundColor DarkYellow
  }
}
if (!$downloaded) {
  Write-Host "下载失败：请检查网络，或开着加速器再试一次。" -ForegroundColor Red
  throw "下载失败"
}

Step "解压并复制文件"
$tmp = Join-Path $env:TEMP ('ch_' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
Expand-Archive -Path $zip -DestinationPath $tmp -Force
$srcDir = Get-ChildItem $tmp -Directory | Select-Object -First 1
if (!$srcDir) { throw "解压结果异常" }
Copy-Item (Join-Path $srcDir.FullName '*') $InstallDir -Recurse -Force
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

Step "写入启动脚本"
$nodeCmd = @'
@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装：https://nodejs.org
  pause
  exit /b 1
)
node ai-tiku-server.js
pause
'@
[System.IO.File]::WriteAllText((Join-Path $InstallDir '启动AI服务.cmd'), $nodeCmd, (New-Object System.Text.ASCIIEncoding))

Step "启动本地 AI 服务"
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  try {
    Start-Process -FilePath $node.Source -ArgumentList 'ai-tiku-server.js' -WorkingDirectory $InstallDir -WindowStyle Hidden
    Start-Sleep -Seconds 3
    try {
      $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 5
      if ($h.ok) { Write-Host "    服务已启动：http://127.0.0.1:8765/health" -ForegroundColor Green }
      else { Write-Host "    服务已启动（状态异常，可稍后重试）" -ForegroundColor Yellow }
    } catch {
      Write-Host "    服务已启动，但暂时连不上，稍等几秒或双击「启动AI服务.cmd」查看" -ForegroundColor Yellow
    }
  } catch {
    Write-Host "    自动启动失败，请双击：$InstallDir\启动AI服务.cmd" -ForegroundColor Yellow
  }
} else {
  Write-Host "    没检测到 Node.js（AI 答题服务需要它）" -ForegroundColor Yellow
  Write-Host "    下载：https://nodejs.org  （只装脚本、不用 AI 答题可忽略）" -ForegroundColor Yellow
}

Step "打开安装页面"
Start-Process 'https://www.tampermonkey.net/?browser=edge'
Start-Sleep -Milliseconds 800
Start-Process ('https://github.com/' + $Repo + '/blob/main/INSTALL.md')

Write-Host ""
Write-Host "  部署完成，接下来手动 2 步：" -ForegroundColor Green
Write-Host "  1) 浏览器装好 Tampermonkey 扩展"
Write-Host "  2) 把 $InstallDir\scripts 里的 6 个 .user.js 拖进浏览器安装"
Write-Host ""
Write-Host "  详细说明：$InstallDir\INSTALL.md" -ForegroundColor DarkGray
Write-Host ""
