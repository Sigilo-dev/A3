param()

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$cache = Join-Path $root '.cache'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$lock = Get-Content -Raw -LiteralPath (Join-Path $root 'binaries.lock.json') | ConvertFrom-Json

foreach ($name in @('plantuml', 'structurizr')) {
    $artifact = $lock.artifacts.$name
    $fileName = [IO.Path]::GetFileName(([Uri]$artifact.url).AbsolutePath)
    $path = Join-Path $cache $fileName
    if (-not (Test-Path -LiteralPath $path)) {
        Invoke-WebRequest -Uri $artifact.url -OutFile $path
    }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
    if ($hash -ne $artifact.sha256) {
        throw "SHA-256 mismatch for ${fileName}: $hash"
    }
    Write-Output "$name $($artifact.version) sha256=$hash"
}
