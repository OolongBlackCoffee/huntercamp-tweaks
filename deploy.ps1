# ============================================================================
#  HUNTER CAMP 一键部署 / 还原
#  ---------------------------------------------------------------------------
#  软件升级、覆盖安装、甚至重装之后，双击「一键部署.bat」即可恢复全部改动：
#    1) 首页「触控板」卡片 —— 替换原「逗逗陪玩」卡片，与「深度优化」联动
#    2) 首页「显卡降压」卡片 —— VF 曲线编辑器（配合本机降频服务 HcGpuSvc）
#    3) 彻底隐藏「逗逗陪玩」—— 侧栏入口、跳转路由、配置、Web 前端、主程序
#    4) 显卡降压后端服务 —— 复制 exe 到 ProgramData、注册 SYSTEM 计划任务、启动
#    5) 解除 GPU 超频上限（核心 600 / 显存 1200）
#    6) 重启猎人营地
#
#  用法：
#    双击「一键部署.bat」            → 部署（自动提权）
#    双击「还原.bat」                → 还原到官方原状
#    powershell -File deploy.ps1 [-Restore] [-Quiet] [-SkipService] [-SkipAppRestart]
# ============================================================================

param(
    [switch]$Restore,
    [switch]$Quiet,
    [switch]$SkipService,
    [switch]$SkipAppRestart
)

$ErrorActionPreference = 'Continue'

if ($Quiet) {
    $logPath = Join-Path (Split-Path -Parent $PSCommandPath) 'deploy-last.log'
    try { Start-Transcript -Path $logPath -Force | Out-Null } catch {}
}

$Here        = Split-Path -Parent $MyInvocation.MyCommand.Path
$Payload     = Join-Path $Here 'payload'
$BackupHeavy = Join-Path $Here 'backup-heavy'
$SvcDir      = 'C:\ProgramData\HunterCamp-GpuSvc'
$SvcExe      = Join-Path $SvcDir 'HcGpuSvc.exe'
$SvcTask     = 'HunterCamp-GpuSvc'
$SvcPort     = 8977

$done = New-Object System.Collections.ArrayList
function Say($m) { Write-Host $m }
function OK($m)  { Write-Host ("  [OK] " + $m); [void]$done.Add($m) }
function Skip($m){ Write-Host ("  [--] " + $m) }
function Warn($m){ Write-Host ("  [!!] " + $m) }

# ---------- 提权 ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Say '需要管理员权限，正在提权……'
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($Restore)        { $a += '-Restore' }
    if ($Quiet)          { $a += '-Quiet' }
    if ($SkipService)    { $a += '-SkipService' }
    if ($SkipAppRestart) { $a += '-SkipAppRestart' }
    Start-Process powershell.exe -Verb RunAs -ArgumentList $a
    exit
}

# ---------- 找安装目录 ----------
$root = $null
foreach ($k in @('HKLM:\SOFTWARE\HONOR\HunterCamp', 'HKLM:\SOFTWARE\WOW6432Node\HONOR\HunterCamp')) {
    if (Test-Path $k) {
        $v = Get-ItemProperty $k -ErrorAction SilentlyContinue
        foreach ($p in @('InstallRoot', 'InstallPath', 'Path', 'InstallDir')) {
            if ($v.$p -and (Test-Path (Join-Path $v.$p 'HUNTERCAMP.exe'))) { $root = $v.$p; break }
        }
    }
    if ($root) { break }
}
if (-not $root) {
    foreach ($cand in @('C:\Program Files\HONOR\HunterCamp', 'D:\Users\14303\AppData\Local\Honor\HunterCamp')) {
        if (Test-Path (Join-Path $cand 'HUNTERCAMP.exe')) { $root = $cand; break }
    }
}
if (-not $root) { Say '找不到猎人营地安装目录，请手动确认。'; if (-not $Quiet) { Read-Host '按回车退出' }; exit 1 }
Say "安装目录: $root"

$idx   = Join-Path $root 'build\index.html'
$jsDir = Join-Path $root 'build\static\js'
$Scripts = @('huntercamp-nodoudou.js', 'huntercamp-homecard.js', 'huntercamp-uv.js')

function Stop-App {
    Get-Process HUNTERCAMP -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
}
function Start-App {
    if ($SkipAppRestart) { Skip '按参数要求未启动应用'; return }
    Stop-Service HunterCampService -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 600
    Start-Service HunterCampService -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 600
    Start-Process (Join-Path $root 'HUNTERCAMP.exe')
}

# ---------- 显卡服务：安装 / 卸载 ----------
function Install-GpuService {
    $src = Join-Path $Payload 'HcGpuSvc.exe'
    if (-not (Test-Path $src)) { Warn 'payload 里没有 HcGpuSvc.exe，跳过降频服务'; return }
    New-Item -ItemType Directory -Force -Path $SvcDir | Out-Null

    Stop-Process -Name HcGpuSvc -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 600

    if (-not (Test-Path $SvcExe) -or ((Get-Item $src).Length -ne (Get-Item $SvcExe).Length)) {
        Copy-Item $src $SvcExe -Force
        OK '已安装降频服务程序'
    } else {
        Skip '降频服务程序已是最新'
    }

    $tr = '"' + $SvcExe + '"'
    $null = & schtasks /Create /TN $SvcTask /TR $tr /SC ONSTART /RU 'SYSTEM' /RL HIGHEST /F 2>&1
    OK '已注册开机自启计划任务（SYSTEM）'

    $null = & schtasks /Run /TN $SvcTask 2>&1
    Start-Sleep -Seconds 3

    $okPort = $false
    try {
        $r = Invoke-WebRequest ("http://127.0.0.1:$SvcPort/ping") -UseBasicParsing -TimeoutSec 6
        if ($r.Content -match '"ok":true') { $okPort = $true }
    } catch {}
    if ($okPort) { OK "降频服务已就绪（127.0.0.1:$SvcPort）" }
    else {
        Warn '服务端口没响应，直接前台起一个试试'
        try { Start-Process -FilePath $SvcExe -WindowStyle Hidden } catch {}
        Start-Sleep -Seconds 3
        try {
            $r2 = Invoke-WebRequest ("http://127.0.0.1:$SvcPort/ping") -UseBasicParsing -TimeoutSec 6
            if ($r2.Content -match '"ok":true') { OK "降频服务已就绪（127.0.0.1:$SvcPort）" } else { Warn '降频服务仍未就绪' }
        } catch { Warn '降频服务仍未就绪' }
    }
}

function Remove-GpuService {
    $null = & schtasks /End /TN $SvcTask 2>&1
    $null = & schtasks /Delete /TN $SvcTask /F 2>&1
    Stop-Process -Name HcGpuSvc -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 600
    if (Test-Path $SvcDir) { Remove-Item $SvcDir -Recurse -Force -ErrorAction SilentlyContinue }
    OK '降频服务与计划任务已移除'
}

# ---------- GPU 超频上限：核心 200→600、显存 400→1200 ----------
function Find-Node {
    foreach ($cand in @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
        (Join-Path $env:APPDATA 'nvm\nodejs\node.exe'),
        $env:NVM_SYMLINK)) {
        if ($cand -and (Test-Path (Join-Path $cand 'node.exe'))) { return (Join-Path $cand 'node.exe') }
        if ($cand -and (Test-Path $cand) -and $cand.EndsWith('node.exe')) { return $cand }
    }
    $c = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    return $null
}

function Patch-OcLimit([switch]$Undo) {
    $node = Find-Node
    if (-not $node) { Warn '找不到 node.exe，跳过超频上限修改'; return }
    $js = Join-Path $Payload 'patch-oclimit.js'
    if (-not (Test-Path $js)) { Warn 'payload 缺少 patch-oclimit.js，跳过超频上限修改'; return }
    $cmdArgs = @($js, $jsDir)
    if ($Undo) { $cmdArgs += '--restore' }
    $lines = & $node @cmdArgs 2>&1
    foreach ($l in $lines) { Say ('  ' + $l) }
    if ($LASTEXITCODE -eq 0) {
        if ($Undo) { OK 'GPU 超频上限已还原（核心 200 / 显存 400）' }
        else       { OK 'GPU 超频上限已解除（核心 600 / 显存 1200）' }
    } else {
        Warn "超频上限脚本返回 $LASTEXITCODE"
    }
}

# ============================================================================
#  还原模式
# ============================================================================
if ($Restore) {
    Say ''
    Say '=== 还原模式 ==='

    Stop-App

    if (-not $SkipService) { Remove-GpuService }

    Patch-OcLimit -Undo

    foreach ($f in $Scripts) {
        $p = Join-Path $jsDir $f
        if (Test-Path $p) { Remove-Item $p -Force -ErrorAction SilentlyContinue; OK "已删除 $f" }
    }

    $orig = Join-Path $root 'build\index.html.orig-bak.fixed'
    if (-not (Test-Path $orig)) { $orig = Join-Path $root 'build\index.html.orig-bak' }
    if (Test-Path $orig) { Copy-Item $orig $idx -Force; OK 'index.html 已还原' }
    else { Skip '没有找到 index.html 备份' }

    $xml = Join-Path $root 'Xml\HunterCampDoudou.xml'
    if (Test-Path $xml) {
        $t = [System.IO.File]::ReadAllText($xml) -replace 'Open="0"', 'Open="1"'
        [System.IO.File]::WriteAllText($xml, $t, (New-Object System.Text.UTF8Encoding($false)))
        OK '逗逗配置 Open="1"'
    }

    foreach ($rel in @('Program\1.1.6.4\Assets\Web', 'AppData\DoudouAI_Honor.exe.WebView2', 'Program\1.1.6.4\DoudouAI_Honor.exe')) {
        $src = Join-Path $BackupHeavy $rel
        $dst = Join-Path $root $rel
        if (-not (Test-Path $src)) { continue }
        $parent = Split-Path -Parent $dst
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
        if (Test-Path $src -PathType Container) { robocopy $src $dst /MOVE /E /NFL /NDL /NJH /NJS | Out-Null }
        else { Move-Item $src $dst -Force }
        OK ("已搬回 " + $rel)
    }

    Start-App

    Say ''
    Say '========================================'
    Say ' 已还原到官方原状（逗逗可以正常打开）'
    Say '========================================'
    if (-not $Quiet) { Read-Host '按回车退出' }
    exit 0
}

# ============================================================================
#  部署
# ============================================================================
Say ''
Say '=== 1/6 注入前端脚本 ==='
foreach ($f in $Scripts) {
    $src = Join-Path $Payload $f
    if (-not (Test-Path $src)) { Warn "payload 缺少 $f"; continue }
    Copy-Item $src (Join-Path $jsDir $f) -Force
    OK "已部署 $f"
}
foreach ($old in @('huntercamp-touchpad.js', 'huntercamp-probe.js', 'huntercamp-probe2.js')) {
    $p = Join-Path $jsDir $old
    if (Test-Path $p) { Remove-Item $p -Force -ErrorAction SilentlyContinue; Say "  已清理旧脚本 $old" }
}

Say ''
Say '=== 2/6 解除 GPU 超频上限 ==='
Patch-OcLimit

Say ''
Say '=== 3/6 修补 index.html ==='
if (Test-Path $idx) {
    $html = [System.IO.File]::ReadAllText($idx)
    if (-not (Test-Path "$idx.orig-bak.fixed") -and ($html -notmatch 'huntercamp-')) {
        Copy-Item $idx "$idx.orig-bak.fixed" -Force
        Say '  已保存官方原始 index.html 备份'
    }
    $html = [regex]::Replace($html, '<script[^>]*huntercamp-touchpad\.js[^>]*>\s*</script>', '')
    if ($html -notmatch 'hc-nodoudou-css') {
        $html = $html.Replace('</body>', '<style id="hc-nodoudou-css">a[href*="/aicompanion"]{display:none!important}</style></body>')
    }
    # 先摘掉旧的注入标签，再带版本号重新注入：WebView2 会缓存静态 js，
    # 不加 ?v= 时改了脚本也不生效（排查过一整个来回）。
    foreach ($f in $Scripts) {
        $html = [regex]::Replace($html, '<script[^>]*' + [regex]::Escape($f) + '[^>]*>\s*</script>', '')
    }
    $v = [DateTime]::Now.ToString('MMddHHmmss')
    foreach ($f in $Scripts) {
        $tag = '<script defer="defer" src="/static/js/' + $f + '?v=' + $v + '"></script>'
        $html = $html.Replace('</body>', $tag + '</body>')
    }
    [System.IO.File]::WriteAllText($idx, $html, (New-Object System.Text.UTF8Encoding($false)))
    OK ('index.html 已注入 ' + $Scripts.Count + ' 个脚本（v=' + $v + '）+ 逗逗入口隐藏样式')
} else {
    Warn "找不到 $idx"
}

Say ''
Say '=== 4/6 关闭逗逗配置 ==='
$xml = Join-Path $root 'Xml\HunterCampDoudou.xml'
if (Test-Path $xml) {
    $t = [System.IO.File]::ReadAllText($xml) -replace 'Open="1"', 'Open="0"'
    [System.IO.File]::WriteAllText($xml, $t, (New-Object System.Text.UTF8Encoding($false)))
    OK '逗逗配置 Open="0"'
} else { Skip '没有 HunterCampDoudou.xml（可能已彻底移除）' }

Say ''
Say '=== 5/6 隔离逗逗大件 ==='
New-Item -ItemType Directory -Force -Path $BackupHeavy | Out-Null
$moved = 0
foreach ($rel in @('Program\1.1.6.4\Assets\Web', 'AppData\DoudouAI_Honor.exe.WebView2', 'Program\1.1.6.4\DoudouAI_Honor.exe')) {
    $src = Join-Path $root $rel
    if (-not (Test-Path $src)) { continue }
    $dst = Join-Path $BackupHeavy $rel
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    if (Test-Path $src -PathType Container) { robocopy $src $dst /MOVE /E /NFL /NDL /NJH /NJS | Out-Null }
    else { Move-Item $src $dst -Force }
    OK ("已隔离 " + $rel)
    $moved++
}
if ($moved -eq 0) { Skip '逗逗大件已不在（之前处理过）' }

Say ''
Say '=== 6/6 显卡降压服务 ==='
if ($SkipService) { Skip '按参数要求跳过降频服务' } else { Install-GpuService }

Say ''
Say '=== 重启猎人营地 ==='
Stop-App
Start-App
Start-Sleep -Seconds 4
$p = Get-Process HUNTERCAMP -ErrorAction SilentlyContinue | Select-Object -First 1
if ($p) { OK "猎人营地已启动（pid $($p.Id)）" } else { Warn '猎人营地没起来，请手动启动' }

Say ''
Say '====================================================='
Say ' 部署完成，清单：'
foreach ($d in $done) { Say ("   - " + $d) }
Say ''
Say ' 首页：触控板卡片（联动深度优化）+ 显卡降压卡片'
Say ' 侧栏：逗逗陪玩入口已隐藏'
Say ' 界面没出现时按 Win+Shift+G 呼出'
Say '====================================================='
if (-not $Quiet) { Read-Host '按回车退出' }
