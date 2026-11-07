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

# ---------- 5. 安装 OCS 网课助手（可选，装了才能在 OCS 里自动装脚本） ----------
Step "检查 OCS 网课助手"

$ocsExe = Join-Path $env:LOCALAPPDATA 'Programs\OCS Desktop\OCS Desktop.exe'
$ocsCfg = Join-Path $env:APPDATA 'OCS Desktop\config.json'
$ocsInstalled = (Test-Path $ocsExe) -or (Test-Path $ocsCfg)

if (-not $ocsInstalled) {
  Write-Host "    未安装 OCS，正在下载官方安装包（约 106 MB，官方 CDN）…" -ForegroundColor Yellow
  $setup = Join-Path $env:TEMP 'ocs-setup.exe'
  $cdn = 'https://cdn.ocsjs.com/app/electron-updater//ocs-3.9.1-setup-win-x64.exe'
  $proxied = 'https://gh-proxy.com/https://github.com/ocsjs/ocs-desktop/releases/download/v3.9.1/ocs-3.9.1-setup-win-x64.exe'
  $dlOk = $false
  foreach ($u in @($cdn, $proxied)) {
    try {
      Write-Host ("    · " + $u) -ForegroundColor DarkGray
      Invoke-WebRequest -Uri $u -OutFile $setup -UseBasicParsing -TimeoutSec 900
      if ((Get-Item $setup).Length -gt 50000000) { $dlOk = $true; break }
    } catch {
      Write-Host ("      下载失败：" + $_.Exception.Message) -ForegroundColor DarkYellow
    }
  }
  if ($dlOk) {
    Write-Host "    正在静默安装 OCS（约 1-2 分钟，别关窗口）…" -ForegroundColor Yellow
    Start-Process -FilePath $setup -ArgumentList '/S' -Wait
    Start-Sleep -Seconds 5
    if (Test-Path $ocsExe) {
      Write-Host "    OCS 安装完成" -ForegroundColor Green
      $ocsInstalled = $true
    } else {
      Write-Host "    安装后没找到 OCS 主程序（可能装到别处），跳过后续自动配置" -ForegroundColor DarkYellow
    }
  } else {
    Write-Host "    OCS 下载失败，跳过。可手动安装：https://docs.ocsjs.com/docs/app" -ForegroundColor DarkYellow
  }
} else {
  Write-Host "    已安装 OCS" -ForegroundColor Green
}

# OCS 首次运行才会生成 config.json：先启动一次，拿到配置后再写脚本
if ($ocsInstalled -and !(Test-Path $ocsCfg)) {
  Write-Host "    首次启动 OCS 生成配置（最多等 60 秒，任务栏可能弹出 OCS 窗口）…" -ForegroundColor Yellow
  if (Test-Path $ocsExe) { Start-Process -FilePath $ocsExe | Out-Null }
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 3
    if (Test-Path $ocsCfg) { break }
  }
  if (Test-Path $ocsCfg) {
    Write-Host "    配置已生成，关闭 OCS 以写入脚本…" -ForegroundColor Green
    Start-Sleep -Seconds 2
    Stop-Process -Name 'OCS Desktop' -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
  } else {
    Write-Host "    配置还没生成：请手动打开 OCS，点一次顶部「一键初始化」，再重新运行本脚本" -ForegroundColor Yellow
  }
}

# ---------- 6. 脚本手动添加指引（OCS 3.9.x 配置加密，不能在外部写） ----------
Step "脚本手动添加指引"
$scriptBase = 'http://127.0.0.1:8765/scripts/'
$scriptList = @(
  @{ file = 'course-helper.user.js';         name = '网课助手·自动挂机跳未学' },
  @{ file = 'course-exam.user.js';           name = '作业流程助手' },
  @{ file = 'course-discuss.user.js';        name = '讨论区自动参与' },
  @{ file = 'course-grade-feedback.user.js'; name = '成绩回填' },
  @{ file = 'course-mastery.user.js';        name = '掌握度助手' },
  @{ file = 'course-login.user.js';          name = '登录助手' }
)

Write-Host "    OCS 新版（3.x）的配置是加密的，脚本不能在安装时直接写进去，" -ForegroundColor Yellow
Write-Host "    需要在 OCS 界面里手动加一次（只加一次，以后打开 OCS 会自动安装）：" -ForegroundColor Yellow
Write-Host ""
Write-Host "    ① 打开 OCS → 左侧「脚本列表」→ 右上角「+ 添加网络脚本」" -ForegroundColor White
Write-Host "    ② 一条一条粘贴下面的地址（6 条）：" -ForegroundColor White
foreach ($s in $scriptList) {
  Write-Host ("         " + $scriptBase + $s.file) -ForegroundColor Cyan
  Write-Host ("           名称填：" + $s.name) -ForegroundColor DarkGray
}
Write-Host "    ③ 加完后重开 OCS 的内置浏览器，脚本会自动装好" -ForegroundColor White
Write-Host ""
Write-Host "    脚本文件也在本地：$InstallDir\scripts\（用 Tampermonkey 拖拽安装也行）" -ForegroundColor DarkGray

# ---------- 7. 打开帮助页面 ----------
Step "打开帮助页面"
Start-Process 'https://www.tampermonkey.net/?browser=edge'
Start-Sleep -Milliseconds 600
Start-Process ('https://github.com/' + $Repo + '/blob/main/INSTALL.md')

Write-Host ""
Write-Host "  部署完成（还差 1 步手动）：" -ForegroundColor Green
if ($ocsInstalled) {
  Write-Host "  打开 OCS → 脚本列表 → + 添加网络脚本 → 粘贴上面 6 条地址（每条一次）"
  Write-Host "  然后重开 OCS 里的浏览器，脚本会自动安装。"
} else {
  Write-Host "  浏览器装好 Tampermonkey，把 $InstallDir\scripts\ 里 6 个 .user.js 拖进去安装。"
}
Write-Host ""
Write-Host "  详细说明：$InstallDir\INSTALL.md" -ForegroundColor DarkGray
Write-Host ""
