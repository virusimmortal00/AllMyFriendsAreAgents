<#
.SYNOPSIS
Installs, updates, rolls back, or uninstalls the supported Windows x64 bundle.

.EXAMPLE
.\install-windows.ps1

Installs the current release to the unprivileged per-user default and adds the
launcher directory to the user PATH.

.EXAMPLE
.\install-windows.ps1 -Version 0.1.0 -InstallDirectory "D:\Tools\AMFAA" -NoPath

Installs one immutable version without changing PATH.

.EXAMPLE
.\install-windows.ps1 -Rollback

.EXAMPLE
.\install-windows.ps1 -Uninstall
#>
[CmdletBinding(DefaultParameterSetName = "Install")]
param(
    [Parameter(ParameterSetName = "Install")]
    [ValidatePattern('^(?:current|(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?)$')]
    [string] $Version = "current",

    [Parameter(ParameterSetName = "Install")]
    [Parameter(ParameterSetName = "Rollback")]
    [Parameter(ParameterSetName = "Uninstall")]
    [string] $InstallDirectory = (Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Programs\AllMyFriendsAreAgents"),

    [Parameter(ParameterSetName = "Install")]
    [switch] $NoPath,

    [Parameter(ParameterSetName = "Install")]
    [switch] $DryRun,

    [Parameter(Mandatory = $true, ParameterSetName = "Rollback")]
    [switch] $Rollback,

    [Parameter(Mandatory = $true, ParameterSetName = "Uninstall")]
    [switch] $Uninstall
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$script:Product = "all-my-friends-are-agents"
$script:Repository = "https://github.com/virusimmortal00/AllMyFriendsAreAgents"
$script:Target = "windows-x64"
$script:ManifestName = "native-release-manifest.json"
$script:ReceiptName = "installer-receipt.json"
$script:OwnerMarkerName = ".amfaa-installer-root.json"
$script:SupportedTargets = @("darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-x64")

function Assert-WindowsX64Host {
    if (-not [Environment]::Is64BitOperatingSystem -or [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw "The native installer supports only Windows x64."
    }
    $osArchitecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    $processArchitecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture
    if ($osArchitecture -ne [Runtime.InteropServices.Architecture]::X64 -or $processArchitecture -ne [Runtime.InteropServices.Architecture]::X64) {
        throw "The native installer supports only a native Windows x64 PowerShell process."
    }
}

function Get-ObjectPropertyNames([object] $Value) {
    return @($Value.PSObject.Properties.Name | Sort-Object)
}

function Assert-ExactProperties([object] $Value, [string[]] $Expected, [string] $Label) {
    if ($null -eq $Value) { throw "$Label must be an object." }
    $actual = @(Get-ObjectPropertyNames $Value)
    $wanted = @($Expected | Sort-Object)
    if ($actual.Count -ne $wanted.Count -or @(Compare-Object $actual $wanted).Count -ne 0) {
        throw "$Label contains missing or unknown fields."
    }
}

function Assert-ReleaseFile([object] $File, [string] $ExpectedName, [string] $ReleaseBase, [string] $Label) {
    Assert-ExactProperties $File @("name", "sha256", "size", "url") $Label
    if ($File.name -cne $ExpectedName -or $File.name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]+$') { throw "$Label has an invalid immutable name." }
    if ($File.sha256 -cnotmatch '^[0-9a-f]{64}$') { throw "$Label has an invalid SHA-256 digest." }
    if ($File.size -isnot [ValueType] -or [long]$File.size -lt 1 -or [decimal]$File.size -ne [long]$File.size) { throw "$Label has an invalid size." }
    $expectedUrl = "$ReleaseBase/$ExpectedName"
    if ($File.url -cne $expectedUrl) { throw "$Label is not an immutable release URL bound to its name." }
    $uri = [Uri]$File.url
    if ($uri.Scheme -ne "https" -or $uri.Host -ne "github.com" -or -not [string]::IsNullOrEmpty($uri.UserInfo) -or -not [string]::IsNullOrEmpty($uri.Query) -or -not [string]::IsNullOrEmpty($uri.Fragment)) {
        throw "$Label has a mutable, credentialed, or malformed URL."
    }
}

function Assert-NativeManifest([object] $Manifest, [string] $RequestedVersion) {
    Assert-ExactProperties $Manifest @("application", "downstream", "schemaVersion", "targets") "manifest"
    if ($Manifest.schemaVersion -ne 1) { throw "Unknown native release manifest schema version." }
    Assert-ExactProperties $Manifest.application @("commit", "repository", "version") "manifest.application"
    if ($Manifest.application.version -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$') { throw "Manifest application version is invalid." }
    if ($RequestedVersion -ne "current" -and $Manifest.application.version -cne $RequestedVersion) { throw "Manifest version does not match the requested immutable version." }
    if ($Manifest.application.commit -cnotmatch '^[0-9a-f]{40}$' -or $Manifest.application.repository -cne "$($script:Repository).git") { throw "Manifest application provenance is invalid." }
    Assert-ExactProperties $Manifest.downstream @("commit", "pluginVersion", "repository", "sdkVersion", "version") "manifest.downstream"
    if ($Manifest.downstream.commit -cnotmatch '^[0-9a-f]{40}$' -or $Manifest.downstream.repository -cnotmatch '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git$') { throw "Manifest downstream provenance is invalid." }
    foreach ($property in @("version", "sdkVersion", "pluginVersion")) {
        if ([string]::IsNullOrWhiteSpace([string]$Manifest.downstream.$property)) { throw "Manifest downstream compatibility is incomplete." }
    }
    if ($Manifest.targets -isnot [Array] -or $Manifest.targets.Count -ne $script:SupportedTargets.Count) { throw "Manifest does not contain the complete supported native target matrix." }
    $seen = @{}
    foreach ($target in $Manifest.targets) {
        Assert-ExactProperties $target @("artifact", "id", "provenance", "sbom") "manifest target"
        if ($target.id -notin $script:SupportedTargets -or $seen.ContainsKey([string]$target.id)) { throw "Manifest contains an unsupported or duplicate native target." }
        $seen[[string]$target.id] = $true
        $extension = if ([string]$target.id -like "windows-*") { ".zip" } else { ".tar.gz" }
        $name = "all-my-friends-are-agents-v$($Manifest.application.version)-$($target.id)$extension"
        $base = "$($script:Repository)/releases/download/v$($Manifest.application.version)"
        Assert-ReleaseFile $target.artifact $name $base "$($target.id) artifact"
        Assert-ReleaseFile $target.sbom "$name.spdx.json" $base "$($target.id) SBOM"
        Assert-ReleaseFile $target.provenance "$name.intoto.jsonl" $base "$($target.id) provenance"
    }
    if (-not $seen.ContainsKey($script:Target)) { throw "Manifest does not contain windows-x64." }
    return @($Manifest.targets | Where-Object { $_.id -ceq $script:Target })[0]
}

function Get-Sha256([string] $Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-SafeInstallRoot([string] $Path, [bool] $RequireReceipt) {
    $resolved = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $root = [IO.Path]::GetPathRoot($resolved).TrimEnd('\')
    $forbidden = @(
        $root,
        [Environment]::GetFolderPath("UserProfile"),
        [Environment]::GetFolderPath("LocalApplicationData"),
        [Environment]::GetFolderPath("Windows"),
        [Environment]::GetFolderPath("ProgramFiles"),
        [Environment]::GetFolderPath("ProgramFilesX86")
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') }
    if ($forbidden -icontains $resolved) { throw "The installation directory is too broad or system-owned." }
    $cursor = $resolved
    while (-not [string]::IsNullOrEmpty($cursor) -and $cursor.Length -gt $root.Length) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "The installation directory must be a real directory, not a file or reparse point." }
        }
        $parent = (Split-Path -Parent $cursor).TrimEnd('\')
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    if (Test-Path -LiteralPath $resolved) {
        $receiptPath = Join-Path $resolved $script:ReceiptName
        $markerPath = Join-Path $resolved $script:OwnerMarkerName
        $owned = $false
        if (Test-Path -LiteralPath $receiptPath) {
            $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
            if ($receipt.schemaVersion -ne 1 -or $receipt.target -cne $script:Target) { throw "The installation directory has an invalid ownership receipt." }
            $owned = $true
        }
        if (Test-Path -LiteralPath $markerPath) {
            $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
            if ($marker.schemaVersion -ne 1 -or $marker.application -cne $script:Product) { throw "The installation directory has an invalid ownership marker." }
            $owned = $true
        }
        if (-not $owned -and ($RequireReceipt -or @(Get-ChildItem -LiteralPath $resolved -Force).Count -ne 0)) {
            throw "The installation directory is not empty and is not owned by this installer."
        }
    } elseif ($RequireReceipt) { throw "No installer-owned installation exists at the requested directory." }
    return $resolved
}

function Invoke-VerifiedDownload([object] $File, [string] $Destination) {
    Invoke-WebRequest -Uri $File.url -OutFile $Destination -UseBasicParsing
    $item = Get-Item -LiteralPath $Destination
    if ($item.Length -ne [long]$File.size) { throw "Release file size verification failed for $($File.name)." }
    if ((Get-Sha256 $Destination) -cne $File.sha256) { throw "Release file SHA-256 verification failed for $($File.name)." }
}

function ConvertFrom-Base64Json([string] $Value) {
    try { return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value)) | ConvertFrom-Json }
    catch { return $null }
}

function Find-InTotoStatements([object] $Value, [int] $Depth = 0) {
    if ($null -eq $Value -or $Depth -gt 8) { return @() }
    $statements = @()
    if ($Value.PSObject.Properties.Name -contains "_type" -and [string]$Value._type -like "https://in-toto.io/Statement/*") { $statements += $Value }
    foreach ($property in @($Value.PSObject.Properties)) {
        if ($property.Name -eq "payload" -and $property.Value -is [string]) {
            $decoded = ConvertFrom-Base64Json ([string]$property.Value)
            if ($null -ne $decoded) { $statements += @(Find-InTotoStatements $decoded ($Depth + 1)) }
        } elseif ($property.Value -is [Array] -or ($null -ne $property.Value -and $property.Value -isnot [string] -and $property.Value -isnot [ValueType])) {
            foreach ($child in @($property.Value)) { $statements += @(Find-InTotoStatements $child ($Depth + 1)) }
        }
    }
    return $statements
}

function Assert-ArtifactProvenance([string] $Path, [object] $Artifact) {
    $statements = @()
    foreach ($line in @(Get-Content -LiteralPath $Path)) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $statements += @(Find-InTotoStatements ($line | ConvertFrom-Json)) }
        catch { throw "Release provenance is not valid JSONL." }
    }
    foreach ($statement in $statements) {
        if ([string]$statement.predicateType -notlike "https://slsa.dev/provenance/*") { continue }
        foreach ($subject in @($statement.subject)) {
            if ($null -ne $subject -and $subject.PSObject.Properties.Name -contains "digest" -and $null -ne $subject.digest -and $subject.digest.PSObject.Properties.Name -contains "sha256" -and $subject.name -ceq $Artifact.name -and $subject.digest.sha256 -ceq $Artifact.sha256) { return }
        }
    }
    throw "Release provenance does not bind the manifest-listed artifact name and SHA-256 digest."
}

function Test-SafeZipEntry([string] $Name) {
    $normalized = $Name.Replace('\', '/')
    if ([string]::IsNullOrEmpty($normalized) -or $normalized.StartsWith('/') -or $normalized.Contains(':') -or $normalized.Contains([char]0)) { return $false }
    $segments = @($normalized.Split('/') | Where-Object { $_ -ne "" })
    if ($segments.Count -eq 0 -or $segments[0] -cne $script:Product -or $segments -contains ".." -or $segments -contains ".") { return $false }
    return $true
}

function Expand-VerifiedBundle([string] $Archive, [string] $Destination) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        $seen = @{}
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if (-not (Test-SafeZipEntry $name) -or $seen.ContainsKey($name)) { throw "Native archive has an unsafe or duplicate entry." }
            $seen[$name] = $true
        }
    } finally { $zip.Dispose() }
    [IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Destination)
    $root = Join-Path $Destination $script:Product
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw "Native archive is missing its application root." }
    return $root
}

function Get-RelativeFiles([string] $Root) {
    $prefix = $Root.TrimEnd('\') + '\'
    return @(Get-ChildItem -LiteralPath $Root -File -Recurse | ForEach-Object { $_.FullName.Substring($prefix.Length).Replace('\', '/') } | Sort-Object)
}

function Assert-VersionDirectory([string] $VersionRoot, [object] $Manifest) {
    $inventoryPath = Join-Path $VersionRoot "inventory.json"
    $releasePath = Join-Path $VersionRoot "app\release.json"
    $inventory = Get-Content -LiteralPath $inventoryPath -Raw | ConvertFrom-Json
    $release = Get-Content -LiteralPath $releasePath -Raw | ConvertFrom-Json
    if ($inventory.schemaVersion -ne 1 -or $inventory.files -isnot [Array]) { throw "Invalid release inventory." }
    if ($release.schemaVersion -ne 1 -or $release.target -cne $script:Target -or $release.application.version -cne $Manifest.application.version -or $release.application.commit -cne $Manifest.application.commit -or $release.downstream.version -cne $Manifest.downstream.version -or $release.downstream.commit -cne $Manifest.downstream.commit) {
        throw "Staged release identity does not match the native manifest."
    }
    $listed = @($inventory.files | ForEach-Object { [string]$_.path } | Sort-Object)
    if (@($listed | Select-Object -Unique).Count -ne $listed.Count) { throw "Release inventory contains duplicate paths." }
    $actual = @(Get-RelativeFiles $VersionRoot | Where-Object { $_ -cne "inventory.json" })
    if ($listed.Count -ne $actual.Count -or @(Compare-Object $listed $actual -CaseSensitive).Count -ne 0) { throw "Release inventory does not match the staged application." }
    foreach ($entry in @($inventory.files)) {
        $entryPath = ([string]$entry.path).Replace('\', '/')
        $segments = @($entryPath.Split('/') | Where-Object { $_ -ne "" })
        if ($entry.type -cne "file" -or [string]::IsNullOrWhiteSpace($entryPath) -or $entryPath.StartsWith('/') -or $entryPath.Contains(':') -or $entryPath.Contains([char]0) -or $segments -contains "." -or $segments -contains ".." -or $entry.sha256 -cnotmatch '^[0-9a-f]{64}$') { throw "Release inventory contains an unsafe entry." }
        if ((Get-Sha256 (Join-Path $VersionRoot $entryPath)) -cne $entry.sha256) { throw "Release file verification failed." }
    }
}

function Set-AtomicText([string] $Path, [string] $Value) {
    $temporary = Join-Path (Split-Path -Parent $Path) ("." + (Split-Path -Leaf $Path) + "." + [Guid]::NewGuid().ToString("N") + ".tmp")
    $backup = "$temporary.backup"
    [IO.File]::WriteAllText($temporary, $Value, (New-Object Text.UTF8Encoding($false)))
    try {
        if (Test-Path -LiteralPath $Path) {
            try { [IO.File]::Replace($temporary, $Path, $backup, $true) }
            catch [PlatformNotSupportedException] { Move-Item -LiteralPath $temporary -Destination $Path -Force }
        } else { Move-Item -LiteralPath $temporary -Destination $Path }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
    }
}

function Set-AtomicFile([string] $Source, [string] $Path) {
    $temporary = Join-Path (Split-Path -Parent $Path) ("." + (Split-Path -Leaf $Path) + "." + [Guid]::NewGuid().ToString("N") + ".tmp")
    $backup = "$temporary.backup"
    Copy-Item -LiteralPath $Source -Destination $temporary
    try {
        if (Test-Path -LiteralPath $Path) {
            try { [IO.File]::Replace($temporary, $Path, $backup, $true) }
            catch [PlatformNotSupportedException] { Move-Item -LiteralPath $temporary -Destination $Path -Force }
        } else { Move-Item -LiteralPath $temporary -Destination $Path }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
    }
}

function Update-UserPath([string] $Directory, [bool] $Add) {
    $current = [Environment]::GetEnvironmentVariable("Path", "User")
    $parts = @($current -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $normalized = $Directory.TrimEnd('\')
    $remaining = @($parts | Where-Object { $_.TrimEnd('\') -ine $normalized })
    if ($Add) { $remaining += $normalized }
    $next = $remaining -join ';'
    if ($next -ne $current) {
        if ($next.Length -gt 32767) { throw "The user PATH would exceed the Windows environment limit." }
        [Environment]::SetEnvironmentVariable("Path", $next, "User")
    }
}

function Get-ActiveVersion([string] $InstallRoot) {
    $value = (Get-Content -LiteralPath (Join-Path $InstallRoot "active-version") -Raw).Trim()
    if ($value -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]+$') { throw "Invalid active version metadata." }
    return $value
}

function Install-AmfaaFromManifest([object] $Manifest, [string] $InstallRoot, [string] $RequestedVersion, [bool] $ModifyUserPath, [scriptblock] $DownloadFile = ${function:Invoke-VerifiedDownload}, [switch] $InterruptAfterDownload) {
    $target = Assert-NativeManifest $Manifest $RequestedVersion
    $InstallRoot = Get-SafeInstallRoot $InstallRoot $false
    [IO.Directory]::CreateDirectory($InstallRoot) | Out-Null
    $ownerMarkerPath = Join-Path $InstallRoot $script:OwnerMarkerName
    if (-not (Test-Path -LiteralPath $ownerMarkerPath)) {
        Set-AtomicText $ownerMarkerPath (([ordered]@{ schemaVersion = 1; application = $script:Product } | ConvertTo-Json -Compress) + "`n")
    }
    $activePath = Join-Path $InstallRoot "active-version"
    $receiptPath = Join-Path $InstallRoot $script:ReceiptName
    $existingPathModified = $false
    if (Test-Path -LiteralPath $receiptPath) {
        $savedReceipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
        $existingPathModified = [bool]$savedReceipt.pathModified
        if ($savedReceipt.schemaVersion -eq 1 -and $savedReceipt.version -ceq $Manifest.application.version -and $savedReceipt.commit -ceq $Manifest.application.commit -and $savedReceipt.target -ceq $script:Target -and (Test-Path -LiteralPath $activePath)) {
            $savedActive = Get-ActiveVersion $InstallRoot
            $savedActiveRoot = Join-Path $InstallRoot "versions\$savedActive"
            $savedRelease = Get-Content -LiteralPath (Join-Path $savedActiveRoot "app\release.json") -Raw | ConvertFrom-Json
            if ($savedRelease.application.version -ceq $Manifest.application.version -and $savedRelease.application.commit -ceq $Manifest.application.commit) {
                Assert-VersionDirectory $savedActiveRoot $Manifest
                if ($ModifyUserPath) { Update-UserPath $InstallRoot $true; $existingPathModified = $true }
                if ($existingPathModified -ne [bool]$savedReceipt.pathModified) {
                    $savedReceipt.pathModified = $existingPathModified
                    Set-AtomicText $receiptPath (($savedReceipt | ConvertTo-Json -Depth 8 -Compress) + "`n")
                }
                return [pscustomobject]@{ version = $Manifest.application.version; reused = $true; installDirectory = $InstallRoot }
            }
        }
    }
    foreach ($stale in @(Get-ChildItem -LiteralPath $InstallRoot -Directory -Filter ".installer-stage-*" -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath $stale.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    $stage = Join-Path $InstallRoot (".installer-stage-" + [Guid]::NewGuid().ToString("N"))
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    try {
        $archive = Join-Path $stage $target.artifact.name
        $sbom = Join-Path $stage $target.sbom.name
        $provenance = Join-Path $stage $target.provenance.name
        & $DownloadFile $target.artifact $archive
        & $DownloadFile $target.sbom $sbom
        & $DownloadFile $target.provenance $provenance
        Assert-ArtifactProvenance $provenance $target.artifact
        if ($InterruptAfterDownload) { throw "Installation interrupted before activation." }
        $expanded = Join-Path $stage "expanded"
        [IO.Directory]::CreateDirectory($expanded) | Out-Null
        $bundle = Expand-VerifiedBundle $archive $expanded
        $candidateName = Get-ActiveVersion $bundle
        $candidateRoot = Join-Path $bundle "versions\$candidateName"
        Assert-VersionDirectory $candidateRoot $Manifest

        $versions = Join-Path $InstallRoot "versions"
        [IO.Directory]::CreateDirectory($versions) | Out-Null
        $destination = Join-Path $versions $candidateName
        if (Test-Path -LiteralPath $destination) { Assert-VersionDirectory $destination $Manifest }
        else { Move-Item -LiteralPath $candidateRoot -Destination $destination }

        foreach ($launcher in @("amfaa.cmd")) {
            $source = Join-Path $bundle $launcher
            if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Native bundle is missing $launcher." }
            $launcherPath = Join-Path $InstallRoot $launcher
            Set-AtomicFile $source $launcherPath
        }

        $oldActive = if (Test-Path -LiteralPath $activePath) { Get-ActiveVersion $InstallRoot } else { $null }
        if ($null -ne $oldActive -and $oldActive -cne $candidateName) {
            Assert-VersionDirectory (Join-Path $versions $oldActive) ((Get-Content -LiteralPath (Join-Path $versions "$oldActive\app\release.json") -Raw | ConvertFrom-Json | ForEach-Object {
                [pscustomobject]@{ application = $_.application; downstream = $_.downstream }
            }))
            Set-AtomicText (Join-Path $InstallRoot "previous.json") (([ordered]@{ schemaVersion = 1; versionDirectory = $oldActive } | ConvertTo-Json -Compress) + "`n")
        }
        Set-AtomicText $activePath ($candidateName + "`n")
        if ($ModifyUserPath) { Update-UserPath $InstallRoot $true; $existingPathModified = $true }
        $receipt = [ordered]@{ schemaVersion = 1; version = $Manifest.application.version; commit = $Manifest.application.commit; target = $script:Target; artifact = $target.artifact; provenance = $target.provenance; pathModified = $existingPathModified }
        Set-AtomicText $receiptPath (($receipt | ConvertTo-Json -Depth 8 -Compress) + "`n")
        return [pscustomobject]@{ version = $Manifest.application.version; reused = ($oldActive -ceq $candidateName); installDirectory = $InstallRoot }
    } finally { if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue } }
}

function Invoke-AmfaaRollback([string] $InstallRoot) {
    $InstallRoot = Get-SafeInstallRoot $InstallRoot $true
    $previousPath = Join-Path $InstallRoot "previous.json"
    $previous = Get-Content -LiteralPath $previousPath -Raw | ConvertFrom-Json
    if ($previous.schemaVersion -ne 1 -or $previous.versionDirectory -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]+$') { throw "Invalid rollback metadata." }
    $current = Get-ActiveVersion $InstallRoot
    $candidate = Join-Path $InstallRoot "versions\$($previous.versionDirectory)"
    $release = Get-Content -LiteralPath (Join-Path $candidate "app\release.json") -Raw | ConvertFrom-Json
    $manifestShape = [pscustomobject]@{ application = $release.application; downstream = $release.downstream }
    Assert-VersionDirectory $candidate $manifestShape
    Set-AtomicText (Join-Path $InstallRoot "active-version") ($previous.versionDirectory + "`n")
    Set-AtomicText $previousPath (([ordered]@{ schemaVersion = 1; versionDirectory = $current } | ConvertTo-Json -Compress) + "`n")
    return $previous.versionDirectory
}

function Invoke-AmfaaUninstall([string] $InstallRoot) {
    if (-not (Test-Path -LiteralPath $InstallRoot -PathType Container)) { return }
    $InstallRoot = Get-SafeInstallRoot $InstallRoot $true
    $receiptPath = Join-Path $InstallRoot $script:ReceiptName
    try { $removePath = [bool](Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json).pathModified } catch { throw "Invalid installer receipt." }
    foreach ($entry in @("versions", "amfaa.cmd", "active-version", "previous.json", $script:ReceiptName, $script:OwnerMarkerName)) {
        $managedPath = Join-Path $InstallRoot $entry
        if (Test-Path -LiteralPath $managedPath) { Remove-Item -LiteralPath $managedPath -Recurse -Force }
    }
    if (@(Get-ChildItem -LiteralPath $InstallRoot -Force).Count -eq 0) { Remove-Item -LiteralPath $InstallRoot -Force }
    if ($removePath) { Update-UserPath $InstallRoot $false }
}

function Invoke-AmfaaInstaller([string] $RequestedVersion, [string] $InstallRoot, [bool] $ModifyUserPath) {
    Assert-WindowsX64Host
    $manifestUrl = if ($RequestedVersion -eq "current") { "$($script:Repository)/releases/latest/download/$($script:ManifestName)" } else { "$($script:Repository)/releases/download/v$RequestedVersion/$($script:ManifestName)" }
    $temporary = Join-Path ([IO.Path]::GetTempPath()) ("amfaa-manifest-" + [Guid]::NewGuid().ToString("N") + ".json")
    try {
        Invoke-WebRequest -Uri $manifestUrl -OutFile $temporary -UseBasicParsing
        if ((Get-Item -LiteralPath $temporary).Length -gt 1048576) { throw "Native release manifest exceeds the size limit." }
        $manifest = Get-Content -LiteralPath $temporary -Raw | ConvertFrom-Json
        return Install-AmfaaFromManifest $manifest $InstallRoot $RequestedVersion $ModifyUserPath
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Show-AmfaaPreview([string] $Action, [string] $RequestedVersion, [string] $InstallRoot, [bool] $ModifyUserPath) {
    $release = if ($RequestedVersion -eq "current") { "Latest release" } else { "Version $RequestedVersion" }
    $pathChange = if ($ModifyUserPath) { "Add $InstallRoot to the user PATH" } else { "None" }
    @(
        "",
        "All My Friends Are Agents",
        "Installer preview",
        "",
        "  Action:       $Action",
        "  Release:      $release",
        "  Platform:     $($script:Target)",
        "  Destination:  $InstallRoot",
        "  PATH changes: $pathChange",
        "",
        "Planned steps:",
        "  1. Read the release manifest from GitHub",
        "  2. Download the application bundle, SBOM, and provenance",
        "  3. Verify file sizes, SHA-256 hashes, provenance, and bundle inventory",
        "  4. Activate the verified launcher in $InstallRoot",
        "",
        "Run again without -DryRun to continue.",
        "No downloads or changes were made."
    ) | Write-Output
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ($DryRun) {
            Show-AmfaaPreview "Install" $Version $InstallDirectory (-not $NoPath)
        }
        elseif ($Rollback) { Assert-WindowsX64Host; $value = Invoke-AmfaaRollback $InstallDirectory; Write-Output "Rolled back All My Friends Are Agents to $value." }
        elseif ($Uninstall) { Assert-WindowsX64Host; Invoke-AmfaaUninstall $InstallDirectory; Write-Output "Uninstalled All My Friends Are Agents; user state was retained." }
        else { $result = Invoke-AmfaaInstaller $Version $InstallDirectory (-not $NoPath); Write-Output "Installed All My Friends Are Agents $($result.version) in $($result.installDirectory)." }
    } catch {
        Write-Error "All My Friends Are Agents installer failed safely: $($_.Exception.Message)"
        exit 1
    }
}
