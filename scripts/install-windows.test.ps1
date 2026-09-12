$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
. (Join-Path $PSScriptRoot "install-windows.ps1")

function Assert-True([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

function Get-TestSha([string] $Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

function New-TestRelease([string] $Root, [string] $Version, [string] $Commit) {
    $source = Join-Path $Root "source-$Version"
    $product = Join-Path $source "all-my-friends-are-agents"
    $versionName = "$Version-$($Commit.Substring(0, 12))"
    $versionRoot = Join-Path $product "versions\$versionName"
    $app = Join-Path $versionRoot "app"
    [IO.Directory]::CreateDirectory($app) | Out-Null
    [IO.File]::WriteAllText((Join-Path $app "native-cli.mjs"), "// fixture $Version`n")
    $release = [ordered]@{
        schemaVersion = 1
        target = "windows-x64"
        application = [ordered]@{ version = $Version; commit = $Commit }
        node = [ordered]@{ version = "24.5.0" }
        downstream = [ordered]@{ version = "1.18.25-amfaa.2"; commit = "6883ca5bd35a5494fb2759018373308911c79e01"; artifactSha256 = ("a" * 64) }
    }
    [IO.File]::WriteAllText((Join-Path $app "release.json"), (($release | ConvertTo-Json -Depth 8) + "`n"))
    $inventoryFiles = @(Get-ChildItem -LiteralPath $versionRoot -File -Recurse | ForEach-Object {
        [ordered]@{ path = $_.FullName.Substring($versionRoot.Length + 1).Replace('\', '/'); type = "file"; sha256 = Get-TestSha $_.FullName }
    } | Sort-Object path)
    [IO.File]::WriteAllText((Join-Path $versionRoot "inventory.json"), (([ordered]@{ schemaVersion = 1; files = $inventoryFiles } | ConvertTo-Json -Depth 8) + "`n"))
    [IO.File]::WriteAllText((Join-Path $product "active-version"), "$versionName`n")
    [IO.File]::WriteAllText((Join-Path $product "amfaa.cmd"), "@echo off`r`nset `"ROOT=%~dp0`"`r`nset /p VERSION=<`"%ROOT%active-version`"`r`n`"%ROOT%versions\%VERSION%\app\runtime\node\bin\node.exe`" `"%ROOT%versions\%VERSION%\app\native-cli.mjs`" %*`r`n")
    $archiveName = "all-my-friends-are-agents-v$Version-windows-x64.zip"
    $archive = Join-Path $Root $archiveName
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($source, $archive)
    $sbom = Join-Path $Root "$archiveName.spdx.json"
    [IO.File]::WriteAllText($sbom, "{`"spdxVersion`":`"SPDX-2.3`"}`n")
    $provenance = Join-Path $Root "$archiveName.intoto.jsonl"
    $statement = [ordered]@{
        _type = "https://in-toto.io/Statement/v1"
        subject = @([ordered]@{ name = $archiveName; digest = [ordered]@{ sha256 = Get-TestSha $archive } })
        predicateType = "https://slsa.dev/provenance/v1"
        predicate = [ordered]@{ buildDefinition = [ordered]@{ buildType = "https://github.com/Attestations/GitHubActionsWorkflow@v1" } }
    }
    [IO.File]::WriteAllText($provenance, (($statement | ConvertTo-Json -Depth 10 -Compress) + "`n"))
    $resource = @{}
    foreach ($file in @($archive, $sbom, $provenance)) { $resource[(Split-Path -Leaf $file)] = $file }
    return [pscustomobject]@{ archive = $archive; sbom = $sbom; provenance = $provenance; resources = $resource; versionName = $versionName }
}

function New-TestManifest([string] $Version, [string] $Commit, [object] $Release) {
    $ids = @("darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-x64")
    $targets = @()
    foreach ($id in $ids) {
        $extension = if ($id -like "windows-*") { ".zip" } else { ".tar.gz" }
        $name = "all-my-friends-are-agents-v$Version-$id$extension"
        $base = "https://github.com/virusimmortal00/AllMyFriendsAreAgents/releases/download/v$Version"
        if ($id -eq "windows-x64") {
            $targets += [pscustomobject]@{
                id = $id
                artifact = [pscustomobject]@{ name = $name; url = "$base/$name"; size = (Get-Item $Release.archive).Length; sha256 = Get-TestSha $Release.archive }
                sbom = [pscustomobject]@{ name = "$name.spdx.json"; url = "$base/$name.spdx.json"; size = (Get-Item $Release.sbom).Length; sha256 = Get-TestSha $Release.sbom }
                provenance = [pscustomobject]@{ name = "$name.intoto.jsonl"; url = "$base/$name.intoto.jsonl"; size = (Get-Item $Release.provenance).Length; sha256 = Get-TestSha $Release.provenance }
            }
        } else {
            $targets += [pscustomobject]@{
                id = $id
                artifact = [pscustomobject]@{ name = $name; url = "$base/$name"; size = 1; sha256 = ("a" * 64) }
                sbom = [pscustomobject]@{ name = "$name.spdx.json"; url = "$base/$name.spdx.json"; size = 1; sha256 = ("b" * 64) }
                provenance = [pscustomobject]@{ name = "$name.intoto.jsonl"; url = "$base/$name.intoto.jsonl"; size = 1; sha256 = ("c" * 64) }
            }
        }
    }
    return [pscustomobject]@{
        schemaVersion = 1
        application = [pscustomobject]@{ version = $Version; commit = $Commit; repository = "https://github.com/virusimmortal00/AllMyFriendsAreAgents.git" }
        downstream = [pscustomobject]@{ repository = "https://github.com/virusimmortal00/opencode.git"; commit = "6883ca5bd35a5494fb2759018373308911c79e01"; version = "1.18.25-amfaa.2"; sdkVersion = "1.18.25"; pluginVersion = "1.18.25" }
        targets = $targets
    }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("amfaa-windows-installer-test-" + [Guid]::NewGuid().ToString("N"))
$originalUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
[IO.Directory]::CreateDirectory($root) | Out-Null
try {
    $first = New-TestRelease $root "0.1.0" ("b" * 40)
    $firstManifest = New-TestManifest "0.1.0" ("b" * 40) $first
    $downloadFirst = { param($file, $destination) Copy-Item -LiteralPath $first.resources[[string]$file.name] -Destination $destination }.GetNewClosure()
    $install = Join-Path $root "Install location with spaces & punctuation"
    $result = Install-AmfaaFromManifest $firstManifest $install "0.1.0" $false $downloadFirst
    Assert-True (-not $result.reused) "a clean install is activated"
    Assert-True ([Environment]::GetEnvironmentVariable("Path", "User") -ceq $originalUserPath) "the no-PATH option leaves user PATH unchanged"
    Assert-True ((Get-Content -LiteralPath (Join-Path $install "active-version") -Raw).Trim() -ceq $first.versionName) "the first version is active"
    $again = Install-AmfaaFromManifest $firstManifest $install "0.1.0" $false $downloadFirst
    Assert-True $again.reused "an existing immutable version is reused"

    $second = New-TestRelease $root "0.2.0" ("c" * 40)
    $secondManifest = New-TestManifest "0.2.0" ("c" * 40) $second
    $downloadSecond = { param($file, $destination) Copy-Item -LiteralPath $second.resources[[string]$file.name] -Destination $destination }.GetNewClosure()
    Install-AmfaaFromManifest $secondManifest $install "current" $false $downloadSecond | Out-Null
    Assert-True ((Get-Content -LiteralPath (Join-Path $install "active-version") -Raw).Trim() -ceq $second.versionName) "the verified update is active"
    Assert-True ((Get-Content -LiteralPath (Join-Path $install "previous.json") -Raw | ConvertFrom-Json).versionDirectory -ceq $first.versionName) "the prior working version is retained"
    Invoke-AmfaaRollback $install | Out-Null
    Assert-True ((Get-Content -LiteralPath (Join-Path $install "active-version") -Raw).Trim() -ceq $first.versionName) "rollback reactivates the prior version"

    $badHash = $secondManifest | ConvertTo-Json -Depth 12 | ConvertFrom-Json
    @($badHash.targets | Where-Object id -eq "windows-x64")[0].artifact.sha256 = "0" * 64
    try { Install-AmfaaFromManifest $badHash (Join-Path $root "bad-hash") "0.2.0" $false $downloadSecond | Out-Null; throw "bad hash was accepted" } catch { Assert-True ($_.Exception.Message -match "SHA-256") "a bad artifact hash is rejected" }

    $badProvenancePath = Join-Path $root "bad-provenance.jsonl"
    (Get-Content -LiteralPath $second.provenance -Raw).Replace((Get-TestSha $second.archive), ("f" * 64)) | Set-Content -LiteralPath $badProvenancePath -NoNewline
    $badProvenanceManifest = $secondManifest | ConvertTo-Json -Depth 12 | ConvertFrom-Json
    $badProvenanceTarget = @($badProvenanceManifest.targets | Where-Object id -eq "windows-x64")[0]
    $badProvenanceTarget.provenance.size = (Get-Item $badProvenancePath).Length
    $badProvenanceTarget.provenance.sha256 = Get-TestSha $badProvenancePath
    $badResources = @{} + $second.resources; $badResources[$badProvenanceTarget.provenance.name] = $badProvenancePath
    $downloadBadProvenance = { param($file, $destination) Copy-Item -LiteralPath $badResources[[string]$file.name] -Destination $destination }.GetNewClosure()
    try { Install-AmfaaFromManifest $badProvenanceManifest (Join-Path $root "bad-provenance") "0.2.0" $false $downloadBadProvenance | Out-Null; throw "bad provenance was accepted" } catch { Assert-True ($_.Exception.Message -match "provenance") "bad provenance is rejected" }

    $interrupted = Join-Path $root "interrupted"
    try { Install-AmfaaFromManifest $secondManifest $interrupted "0.2.0" $false $downloadSecond -InterruptAfterDownload | Out-Null; throw "interruption was accepted" } catch { Assert-True (-not (Test-Path -LiteralPath (Join-Path $interrupted "active-version"))) "an interrupted download is not activated" }
    Install-AmfaaFromManifest $secondManifest $interrupted "0.2.0" $false $downloadSecond | Out-Null

    $unsupported = $firstManifest | ConvertTo-Json -Depth 12 | ConvertFrom-Json
    @($unsupported.targets)[4].id = "windows-arm64"
    try { Install-AmfaaFromManifest $unsupported (Join-Path $root "unsupported") "0.1.0" $false $downloadFirst | Out-Null; throw "unsupported target was accepted" } catch { Assert-True ($_.Exception.Message -match "unsupported") "an unsupported platform manifest is rejected" }

    $lockedInstall = Join-Path $root "locked"
    Install-AmfaaFromManifest $firstManifest $lockedInstall "0.1.0" $false $downloadFirst | Out-Null
    $activeFile = Join-Path $lockedInstall "active-version"
    $lock = [IO.File]::Open($activeFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try {
        try { Install-AmfaaFromManifest $secondManifest $lockedInstall "0.2.0" $false $downloadSecond | Out-Null; throw "locked activation was accepted" } catch { Assert-True ($_.Exception.Message -notmatch "locked activation was accepted") "a locked activation file fails safely" }
    } finally { $lock.Dispose() }
    Assert-True ((Get-Content -LiteralPath $activeFile -Raw).Trim() -ceq $first.versionName) "a locked-file failure retains the active version"

    if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
        $pathEntry = Join-Path $root "path install"
        $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
        Install-AmfaaFromManifest $firstManifest $pathEntry "0.1.0" $true $downloadFirst | Out-Null
        Install-AmfaaFromManifest $firstManifest $pathEntry "0.1.0" $true $downloadFirst | Out-Null
        Assert-True ((@([Environment]::GetEnvironmentVariable("Path", "User") -split ';' | Where-Object { $_ -ieq $pathEntry })).Count -eq 1) "user PATH addition is idempotent"
        Assert-True ([Environment]::GetEnvironmentVariable("Path", "Machine") -ceq $machinePath) "machine PATH is unchanged"
        Invoke-AmfaaUninstall $pathEntry
        Assert-True ((@([Environment]::GetEnvironmentVariable("Path", "User") -split ';' | Where-Object { $_ -ieq $pathEntry })).Count -eq 0) "uninstall removes only its user PATH entry"
    }

    $unowned = Join-Path $root "unowned"
    [IO.Directory]::CreateDirectory($unowned) | Out-Null
    [IO.File]::WriteAllText((Join-Path $unowned "unrelated.txt"), "keep")
    try { Invoke-AmfaaUninstall $unowned; throw "unowned uninstall was accepted" } catch { Assert-True (Test-Path -LiteralPath (Join-Path $unowned "unrelated.txt")) "uninstall refuses unowned directories" }

    $state = Join-Path $root "retained-user-state"
    [IO.Directory]::CreateDirectory($state) | Out-Null
    [IO.File]::WriteAllText((Join-Path $state "room.json"), "durable")
    [IO.File]::WriteAllText((Join-Path $install "unrelated.txt"), "keep")
    Invoke-AmfaaUninstall $install
    Assert-True ((Get-Content -LiteralPath (Join-Path $install "unrelated.txt") -Raw) -ceq "keep") "uninstall preserves unrelated files in a custom installation directory"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $install "versions"))) "uninstall removes installer-owned versions"
    Assert-True ((Get-Content -LiteralPath (Join-Path $state "room.json") -Raw) -ceq "durable") "uninstall retains user state"

    Write-Output "Windows installer acceptance checks passed."
} finally {
    [Environment]::SetEnvironmentVariable("Path", $originalUserPath, "User")
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
