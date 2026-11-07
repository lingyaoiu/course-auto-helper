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

# ---------- 1. 下载 ----------
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

# ---------- 2. 解压 ----------
Step "解压并复制文件"
$tmp = Join-Path $env:TEMP ('ch_' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
Expand-Archive -Path $zip -DestinationPath $tmp -Force
$srcDir = Get-ChildItem $tmp -Directory | Select-Object -First 1
if (!$srcDir) { throw "解压结果异常" }
Copy-Item (Join-Path $srcDir.FullName '*') $InstallDir -Recurse -Force
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

# ---------- 3. 启动脚本 ----------
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

# ---------- 4. 启动 AI 服务 ----------
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

# ---------- 5. 检测 OCS 并自动注册脚本 ----------
Step "检测 OCS 网课助手"
$ocsCfg = Join-Path $env:APPDATA 'OCS Desktop\config.json'
$scriptList = @(
  @{ file = 'course-helper.user.js';           name = '网课助手·自动挂机跳未学';    desc = '自动播放课程视频、跳过已学、自动进入下一节；学时按真实播放时长累计。' },
  @{ file = 'course-exam.user.js';             name = '作业流程助手';              desc = '作业列表自动进入下一份、等 OCS 答完自动提交、回列表继续。' },
  @{ file = 'course-discuss.user.js';          name = '讨论区自动参与';            desc = '自动回答课程讨论区问题、连发话题。' },
  @{ file = 'course-grade-feedback.user.js';   name = '成绩回填';                  desc = '从结果页提取参考答案，POST 给本地 AI 服务做错题订正。' },
  @{ file = 'course-mastery.user.js';          name = '掌握度助手';                desc = '自动重做掌握度不满 100% 的知识点，答题、提交、回填、返回刷满。' },
  @{ file = 'course-login.user.js';            name = '登录助手';                  desc = '自动勾选协议、选择学校、辅助登录。' }
)
if (!(Test-Path $ocsCfg)) {
  Write-Host "    未检测到 OCS，跳过（将改用 Tampermonkey）" -ForegroundColor DarkGray
} else {
  $proc = @(Get-Process -Name 'OCS Desktop' -ErrorAction SilentlyContinue)
  if ($proc.Count -gt 0) {
    Write-Host "    OCS 正在运行，需要先关闭 OCS 才能写入配置" -ForegroundColor Yellow
    Write-Host "    等我 60 秒，请你手动关掉 OCS…" -ForegroundColor Yellow
    for ($i = 0; $i -lt 12; $i++) {
      Start-Sleep -Seconds 5
      if (!(Get-Process -Name 'OCS Desktop' -ErrorAction SilentlyContinue)) { break }
    }
  }
  if (@(Get-Process -Name 'OCS Desktop' -ErrorAction SilentlyContinue).Count -gt 0) {
    Write-Host "    OCS 仍未关闭，跳过自动注册（可稍后按 INSTALL.md 手动添加）" -ForegroundColor DarkYellow
  } else {
    try {
      Copy-Item $ocsCfg ($ocsCfg + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) -Force
      $cfg = [System.IO.File]::ReadAllText($ocsCfg, (New-Object System.Text.UTF8Encoding($false))) | ConvertFrom-Json
      if (!$cfg.render) { throw "config.json 缺少 render 字段" }
      $existing = @($cfg.render.scripts)
      $added = 0
      foreach ($s in $scriptList) {
        $url = 'http://127.0.0.1:8765/scripts/' + $s.file
        $dup = $existing | Where-Object { $_.url -eq $url -or ($_.info -and $_.info.code_url -eq $url) }
        if ($dup) { continue }
        $ver = '1.0.0'
        $usPath = Join-Path $InstallDir ('scripts\' + $s.file)
        if (Test-Path $usPath) {
          $m = Select-String -Path $usPath -Pattern '@version\s+(\S+)' -List
          if ($m) { $ver = $m.Matches[0].Groups[1].Value }
        }
        $entry = [ordered]@{
          id                   = (Get-Random -Minimum 1000000000 -Maximum 2147483647)
          url                  = $url
          enable               = $true
          isLocalScript        = $false
          isInternetLinkScript = $true
          info                 = [ordered]@{
            name        = $s.name
            version     = $ver
            code_url    = $url
            description = $s.desc
          }
        }
        $existing = @($existing) + [pscustomobject]$entry
        $added++
      }
      if ($added -gt 0) {
        $cfg.render.scripts = @($existing)
        $json = $cfg | ConvertTo-Json -Depth 100
        [System.IO.File]::WriteAllText($ocsCfg, $json, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "    已向 OCS 注册 $added 个脚本（原配置已备份）" -ForegroundColor Green
        Write-Host "    重开 OCS 后会自动安装这些脚本" -ForegroundColor Green
      } else {
        Write-Host "    OCS 里已经注册过这些脚本，无需重复添加" -ForegroundColor Green
      }
    } catch {
      Write-Host ("    自动注册失败：" + $_.Exception.Message) -ForegroundColor DarkYellow
      Write-Host "    可以按 INSTALL.md 手动添加网络脚本" -ForegroundColor DarkYellow
    }
  }
}

# ---------- 6. 打开安装页面 ----------
Step "打开安装页面"
Start-Process 'https://www.tampermonkey.net/?browser=edge'
Start-Sleep -Milliseconds 800
Start-Process ('https://github.com/' + $Repo + '/blob/main/INSTALL.md')

Write-Host ""
Write-Host "  部署完成，接下来手动 2 步：" -ForegroundColor Green
if (@(Get-Process -Name 'OCS Desktop' -ErrorAction SilentlyContinue).Count -gt 0) {
  Write-Host "  1) 关掉 OCS 再重新打开（让它自动安装脚本）"
} else {
  Write-Host "  1) 浏览器装好 Tampermonkey 扩展（或重开 OCS）"
}
Write-Host "  2) 把 $InstallDir\scripts 里的 6 个 .user.js 拖进浏览器安装（用 OCS 可跳过）"
Write-Host ""
Write-Host "  详细说明：$InstallDir\INSTALL.md" -ForegroundColor DarkGray
Write-Host ""
