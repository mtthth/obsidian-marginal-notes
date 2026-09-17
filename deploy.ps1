<#
.SYNOPSIS
    Build le plugin Marginal Notes et le copie dans le dossier plugins d'un vault Obsidian.
.PARAMETER VaultPath
    Chemin racine du vault Obsidian (le dossier qui contient .obsidian). Si omis, le script
    réutilise le chemin enregistré dans deploy.local.json, ou le demande interactivement.
#>
param(
	[string]$VaultPath = ""
)

$ErrorActionPreference = "Stop"

$PluginId = "marginal-notes"
$RootDir = $PSScriptRoot
$ConfigFile = Join-Path $RootDir "deploy.local.json"

# "Copier en tant que chemin" dans l'Explorateur entoure le chemin de guillemets.
function ConvertTo-CleanPath([string]$Path) {
	return $Path.Trim().Trim('"', "'").Trim()
}

$SavedPath = ""
if (-not $VaultPath -and (Test-Path $ConfigFile)) {
	$SavedPath = (Get-Content $ConfigFile -Raw | ConvertFrom-Json).VaultPath
	$VaultPath = $SavedPath
}
$VaultPath = ConvertTo-CleanPath $VaultPath

if (-not $VaultPath -or -not (Test-Path -LiteralPath $VaultPath)) {
	if ($VaultPath) {
		Write-Host "Chemin de vault introuvable : '$VaultPath'" -ForegroundColor Yellow
	} else {
		Write-Host "Aucun chemin de vault fourni." -ForegroundColor Yellow
	}
	$VaultPath = ConvertTo-CleanPath (Read-Host "Chemin du vault Obsidian (ex: C:\Users\moi\Documents\MonVault)")
}

if (-not $VaultPath -or -not (Test-Path -LiteralPath $VaultPath)) {
	throw "Chemin de vault invalide : '$VaultPath'"
}
if (-not (Test-Path -LiteralPath (Join-Path $VaultPath ".obsidian"))) {
	throw "Aucun dossier .obsidian dans '$VaultPath' : ce n'est pas la racine d'un vault Obsidian."
}

if ($VaultPath -ne $SavedPath) {
	@{ VaultPath = $VaultPath } | ConvertTo-Json | Set-Content $ConfigFile
	Write-Host "Chemin enregistré dans deploy.local.json (ignoré par git) pour les prochains déploiements." -ForegroundColor Green
}

Write-Host "Build du plugin..." -ForegroundColor Cyan
Push-Location $RootDir
try {
	npm run build
	if ($LASTEXITCODE -ne 0) { throw "Le build a échoué (npm run build)." }
} finally {
	Pop-Location
}

$TargetDir = Join-Path $VaultPath ".obsidian\plugins\$PluginId"
New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null

Copy-Item (Join-Path $RootDir "main.js") $TargetDir -Force
Copy-Item (Join-Path $RootDir "manifest.json") $TargetDir -Force

$StylesPath = Join-Path $RootDir "styles.css"
if (Test-Path $StylesPath) {
	Copy-Item $StylesPath $TargetDir -Force
}

Write-Host "Plugin déployé dans : $TargetDir" -ForegroundColor Green
Write-Host "Recharge Obsidian (Ctrl+R) ou réactive le plugin si besoin." -ForegroundColor Green
