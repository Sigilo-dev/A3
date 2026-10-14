param()

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $root
try {
    & (Join-Path $PSScriptRoot 'prepare-binaries.ps1')
    $lock = Get-Content -Raw -LiteralPath 'binaries.lock.json' | ConvertFrom-Json
    $jar = Join-Path '.cache' 'plantuml-mit-1.2026.8.jar'
    $source = 'fixtures/plantuml/class-model.puml'
    $manifest = Get-Content -Raw -LiteralPath 'fixtures/manifest.json' | ConvertFrom-Json
    $before = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.ToLowerInvariant()
    $expectedSourceHash = $manifest.files.PSObject.Properties[$source].Value.sha256
    if ($before -ne $expectedSourceHash) { throw "Fixture hash mismatch: $source" }

    $version = (& java -jar $jar -version | Out-String)
    if ($LASTEXITCODE -ne 0 -or $version -notmatch [Regex]::Escape($lock.artifacts.plantuml.version)) { throw 'PlantUML version check failed' }
    $license = (& java -jar $jar -license 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0 -or $license -notmatch 'MIT License') { throw 'MIT flavor license check failed' }

    $output = (Resolve-Path 'outputs/plantuml').Path
    & java -jar $jar -charset UTF-8 -tsvg -o $output $source
    if ($LASTEXITCODE -ne 0) { throw 'PlantUML SVG render failed' }
    & java -jar $jar -charset UTF-8 -tpng -o $output $source
    if ($LASTEXITCODE -ne 0) { throw 'PlantUML PNG render failed' }

    $after = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.ToLowerInvariant()
    if ($after -ne $before) { throw "PlantUML modified its source fixture: $source" }
    foreach ($extension in @('svg', 'png')) {
        $artifact = Join-Path $output "class-model.$extension"
        if (-not (Test-Path -LiteralPath $artifact) -or (Get-Item -LiteralPath $artifact).Length -le 0) { throw "Missing PlantUML output: $artifact" }
    }

    Write-Output $version.Trim()
    Write-Output 'License confirmed by the selected JAR: MIT.'
    Write-Output "Source unchanged: sha256=$after"
    Get-ChildItem -LiteralPath $output -File | Select-Object Name,Length
}
finally { Pop-Location }
