param(
    [string]$Node = $env:NODE
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

function Info($Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Ok($Message) {
    Write-Host "  [OK] $Message" -ForegroundColor Green
}

function Warn($Message) {
    Write-Host "  [!!] $Message" -ForegroundColor Yellow
}

if (-not $Node) {
    $bundled = Join-Path $env:USERPROFILE `
        '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path $bundled) {
        $Node = $bundled
    } else {
        $cmd = Get-Command node -ErrorAction SilentlyContinue
        if ($cmd) {
            $Node = $cmd.Source
        }
    }
}

if (-not $Node) {
    throw 'Node.js not found. Set $env:NODE or install Node.js.'
}

Info 'Checking JavaScript syntax'
& $Node --check extension.js
& $Node --check layouts.js
& $Node --check lifecycle.js
& $Node --check theme.js
& $Node --check dataPaths.js
& $Node --check modalAuth.js
& $Node --check rgbEffects.js
& $Node --check keyboard.js
& $Node --check indicator.js
& $Node --check predictor.js
Ok 'JavaScript parses'

Info 'Checking metadata.json'
& $Node -e "JSON.parse(require('fs').readFileSync('metadata.json', 'utf8'))"
Ok 'metadata.json parses'

Info 'Running predictor unit tests'
& $Node tests/predictor.test.mjs
Ok 'Predictor tests passed'

Info 'Checking package consistency'
& $Node tests/package-consistency.mjs
Ok 'Package consistency passed'

$eslint = Get-Command eslint -ErrorAction SilentlyContinue
if ($eslint) {
    Info 'Running ESLint'
    & $eslint.Source extension.js layouts.js lifecycle.js theme.js dataPaths.js `
        modalAuth.js rgbEffects.js keyboard.js indicator.js predictor.js `
        tests/predictor.test.mjs
    Ok 'ESLint passed'
} else {
    Warn 'eslint not found; skipped JS lint'
}

Info 'Checking for removed modal-debug leftovers'
$stale = Select-String -Path extension.js,nome-osk-crash-logs.sh `
    -Pattern 'modal-debug|OSK_MODAL_DEBUG' -ErrorAction SilentlyContinue
if ($stale) {
    $stale | ForEach-Object { Write-Host $_ }
    throw 'Found stale modal-debug references'
}
Ok 'No stale modal-debug references'

$bash = Get-Command bash -ErrorAction SilentlyContinue
if ($bash) {
    Info 'Checking shell syntax'
    & $bash.Source -n install.sh
    & $bash.Source -n uninstall.sh
    & $bash.Source -n nome-osk-crash-logs.sh
    & $bash.Source -n 'Install Nome - Onscreen Keyboard.sh'
    & $bash.Source -n 'Uninstall Nome - Onscreen Keyboard.sh'
    Ok 'Shell scripts parse'
} else {
    Warn 'bash not found; skipped shell syntax checks'
}

Info 'All available checks passed'
