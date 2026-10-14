param()

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $root
try {
    & (Join-Path $PSScriptRoot 'prepare-binaries.ps1')
    $war = Join-Path '.cache' 'structurizr-2026.09.19-playwright.war'
    $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $root '.cache/playwright'
    $manifest = Get-Content -Raw -LiteralPath 'fixtures/manifest.json' | ConvertFrom-Json
    foreach ($source in @('fixtures/structurizr/workspace.dsl', 'fixtures/structurizr/workspace.json')) {
        $before = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.ToLowerInvariant()
        $expectedSourceHash = $manifest.files.PSObject.Properties[$source].Value.sha256
        if ($before -ne $expectedSourceHash) { throw "Fixture hash mismatch: $source" }
    }

    java -jar $war version
    if ($LASTEXITCODE -ne 0) { throw 'Structurizr version check failed' }
    foreach ($source in @('fixtures/structurizr/workspace.dsl', 'fixtures/structurizr/workspace.json')) {
        java -jar $war validate -w $source
        if ($LASTEXITCODE -ne 0) { throw "Structurizr validation failed: $source" }
    }

    $output = (Resolve-Path 'outputs/structurizr').Path
    java -jar $war export -w 'fixtures/structurizr/workspace.dsl' -f json -o $output
    if ($LASTEXITCODE -ne 0) { throw 'Structurizr JSON export failed' }
    java -jar $war export -w 'fixtures/structurizr/workspace.dsl' -f svg -o $output
    if ($LASTEXITCODE -ne 0) { throw 'Structurizr SVG export failed' }
    java -jar $war export -w 'fixtures/structurizr/workspace.dsl' -f png -o $output
    if ($LASTEXITCODE -ne 0) { throw 'Structurizr PNG export failed' }

    foreach ($name in @('workspace.json', 'context.svg', 'context.png', 'containers.svg', 'containers.png')) {
        $artifact = Join-Path $output $name
        if (-not (Test-Path -LiteralPath $artifact) -or (Get-Item -LiteralPath $artifact).Length -le 0) { throw "Missing Structurizr output: $artifact" }
    }
    $fixtureJsonHash = (Get-FileHash -Algorithm SHA256 -LiteralPath 'fixtures/structurizr/workspace.json').Hash.ToLowerInvariant()
    $exportedJsonHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $output 'workspace.json')).Hash.ToLowerInvariant()
    if ($fixtureJsonHash -ne $exportedJsonHash) { throw 'DSL-to-JSON output differs from the pinned JSON fixture' }
    Write-Output "DSL-to-JSON fixture match: sha256=$exportedJsonHash"

    foreach ($source in @('fixtures/structurizr/workspace.dsl', 'fixtures/structurizr/workspace.json')) {
        $after = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.ToLowerInvariant()
        $expectedSourceHash = $manifest.files.PSObject.Properties[$source].Value.sha256
        if ($after -ne $expectedSourceHash) { throw "Structurizr modified its source fixture: $source" }
        Write-Output "Source unchanged: $source sha256=$after"
    }
    Get-ChildItem -LiteralPath $output -File | Select-Object Name,Length
}
finally {
    Remove-Item Env:PLAYWRIGHT_BROWSERS_PATH -ErrorAction SilentlyContinue
    Pop-Location
}
