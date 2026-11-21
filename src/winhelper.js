'use strict';
/*
 * Builds "Lumio-Windows-Setup.cmd": a double-clickable helper for the Windows
 * PC that hosts the Lumio VM (VMware NAT). It self-elevates, then:
 *   1. adds a VMware NAT port forward (vmnetnat.conf [incomingtcp]) + restarts the NAT service
 *   2. adds a Windows Firewall rule: this port, Private profile, LocalSubnet only
 *   3. offers to remove old "block" rules for vmnat.exe (they override allow rules)
 *   4. offers to switch the home network from Public to Private
 *   5. detects the PC's LAN IP and reports it to Lumio with a single-use token
 *      over TLS pinned to Lumio's certificate fingerprint
 * All values are generated server-side from validated config (IP literals,
 * integers, hex fingerprint, base64url token), so nothing user-controlled is
 * interpolated into the script.
 *
 * Minimal footprint on the Windows drive: the only changes are the one NAT
 * line and the one firewall rule (plus what the user explicitly confirms). No
 * backup copies, logs, temp files or PowerShell caches are written
 * (PSModuleAnalysisCachePath=NUL), "Undo" removes Lumio's changes again, and
 * the helper offers to delete itself when it's done.
 */
const net = require('node:net');

function assertSafe({ vmIp, port, https, fingerprint, token }) {
  if (!net.isIPv4(vmIp)) throw new Error('VM IPv4 address unknown');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Bad port');
  if (https && !/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/.test(fingerprint || '')) throw new Error('Bad certificate fingerprint');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new Error('Bad token');
}

function buildWindowsHelper(opts) {
  assertSafe(opts);
  const { vmIp, port, https, fingerprint, token } = opts;
  const scheme = https ? 'https' : 'http';
  const ps = String.raw`
$ErrorActionPreference = 'Stop'
$VmIp = '${vmIp}'; $Port = ${port}; $Scheme = '${scheme}'
$global:LumioFp = '${https ? fingerprint : ''}'; $Token = '${token}'
$Host.UI.RawUI.WindowTitle = 'Lumio setup'
function Step($t) { Write-Host ''; Write-Host "==> $t" -ForegroundColor Yellow }
function Ok($t) { Write-Host "    OK  $t" -ForegroundColor Green }
function Warn($t) { Write-Host "    !   $t" -ForegroundColor DarkYellow }
function Ask($q) { $a = Read-Host "    $q [Y/n]"; return ($a -eq '' -or $a -match '^[yY]') }
$conf = Join-Path $env:ProgramData 'VMware\vmnetnat.conf'
$RuleName = 'Lumio (VMware NAT)'
$global:LumioExit = 0
function Restart-Nat {
  $svc = Get-Service | Where-Object { $_.DisplayName -like 'VMware NAT*' } | Select-Object -First 1
  if (-not $svc) { throw 'The "VMware NAT Service" was not found.' }
  Restart-Service -InputObject $svc -Force
}
function Read-Conf {
  if (-not (Test-Path -LiteralPath $conf)) { throw "VMware NAT settings not found ($conf). Is VMware Workstation installed and the VM's network set to NAT?" }
  $l = New-Object System.Collections.Generic.List[string]
  Get-Content -LiteralPath $conf | ForEach-Object { $l.Add($_) }
  return ,$l
}
function Write-Conf($l) {
  # Same file, same place: no backup copies are left on the drive.
  [System.IO.File]::WriteAllLines($conf, $l)
  $old = "$conf.lumio-backup"
  if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force }
}
function Offer-SelfDelete {
  Write-Host ''
  if (Ask 'This helper file is no longer needed. Delete it now?') { $global:LumioExit = 10 }
}
Write-Host ''
Write-Host '  Lumio - let phones and TVs in your home reach Lumio' -ForegroundColor Cyan
Write-Host "  VM: $($VmIp):$Port" -ForegroundColor DarkGray
Write-Host '  Tip: with the VM network set to "Bridged" in VMware, none of this is needed.' -ForegroundColor DarkGray
Write-Host ''
Write-Host '    [1] Set up access from phones and TVs (adds 1 NAT line + 1 firewall rule)'
Write-Host '    [2] Undo: remove everything Lumio added to this PC'
Write-Host '    [Q] Quit without changing anything'
$choice = Read-Host '    Choose'
if ($choice -eq '2') {
  try {
    Step 'Removing Lumio from this PC'
    if (Test-Path -LiteralPath $conf) {
      $lines = Read-Conf
      $n = $lines.Count
      for ($i = $lines.Count - 1; $i -ge 0; $i--) { if ($lines[$i] -match ("^\s*$Port\s*=\s*" + [regex]::Escape($VmIp) + ":$Port\s*$")) { $lines.RemoveAt($i) } }
      if ($lines.Count -ne $n) { Write-Conf $lines; Restart-Nat; Ok 'Port forwarding removed' } else { Ok 'No Lumio port forwarding found' }
    }
    $r = @(Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue)
    if ($r.Count -gt 0) { $r | Remove-NetFirewallRule; Ok 'Firewall rule removed' } else { Ok 'No Lumio firewall rule found' }
    Warn 'If you switched your Wi-Fi to Private for Lumio and want it back: Settings > Network & internet > Wi-Fi > (your network) > Public.'
    Offer-SelfDelete
  } catch { Write-Host ''; Write-Host "  Undo failed: $($_.Exception.Message)" -ForegroundColor Red }
  Write-Host ''
  Read-Host '  Press Enter to close' | Out-Null
  exit $global:LumioExit
}
if ($choice -notmatch '^1$') { exit 0 }
try {
  Step 'VMware NAT port forwarding'
  $lines = Read-Conf
  $natLine = $lines | Where-Object { $_ -match '^\s*ip\s*=\s*(\d+\.\d+\.\d+)\.\d+' } | Select-Object -First 1
  if ($natLine -and $natLine -match '^\s*ip\s*=\s*(\d+\.\d+\.\d+)\.') {
    if (-not $VmIp.StartsWith($Matches[1] + '.')) { Warn "The VM ($VmIp) doesn't look like it's on this VMware NAT network ($($Matches[1]).x). Check the VM uses NAT." }
  }
  $sec = -1
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^\s*\[incomingtcp\]\s*$') { $sec = $i; break } }
  if ($sec -lt 0) { $lines.Add(''); $lines.Add('[incomingtcp]'); $sec = $lines.Count - 1 }
  $i = $sec + 1
  while ($i -lt $lines.Count -and $lines[$i] -notmatch '^\s*\[') {
    if ($lines[$i] -match "^\s*$Port\s*=") { $lines.RemoveAt($i) } else { $i++ }
  }
  $lines.Insert($sec + 1, "$Port = $($VmIp):$Port")
  Write-Conf $lines
  Restart-Nat
  Ok "Port $Port on this PC now forwards to the Lumio VM"

  Step 'Windows Firewall'
  Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $RuleName -Description 'Lets devices on your home network reach Lumio. Private networks and local subnet only.' -Direction Inbound -Protocol TCP -LocalPort $Port -Profile Private -RemoteAddress LocalSubnet -Action Allow | Out-Null
  Ok "Allowed TCP $Port from your home network only (Private profile, local subnet)"
  $blocks = @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -like '*vmnat.exe' } | Get-NetFirewallRule | Where-Object { $_.Action -eq 'Block' -and $_.Direction -eq 'Inbound' })
  if ($blocks.Count -gt 0) {
    Warn "$($blocks.Count) old firewall rule(s) BLOCK VMware NAT (created when a firewall prompt was declined). Block rules win over allow rules."
    if (Ask 'Remove them?') { $blocks | Remove-NetFirewallRule; Ok 'Removed' } else { Warn 'Kept: other devices will probably not be able to connect.' }
  }

  Step 'Home network type'
  $profiles = @(Get-NetConnectionProfile | Where-Object { $_.IPv4Connectivity -ne 'Disconnected' -and $_.InterfaceAlias -notmatch 'VMware|vEthernet|VirtualBox' })
  foreach ($p in $profiles) {
    if ($p.NetworkCategory -eq 'Public') {
      Warn "'$($p.Name)' ($($p.InterfaceAlias)) is set to Public, which blocks devices from connecting."
      if (Ask 'Is this your home network? Switch it to Private?') { Set-NetConnectionProfile -InterfaceIndex $p.InterfaceIndex -NetworkCategory Private; Ok 'Now Private' }
    } else { Ok "'$($p.Name)' is $($p.NetworkCategory)" }
  }

  Step "This PC's address on your home network"
  $cfg = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'VMware|Hyper-V|VirtualBox|WSL|TAP|WireGuard' } | Select-Object -First 1
  if (-not $cfg) { throw 'Could not find an active home network connection.' }
  $HostIp = @($cfg.IPv4Address)[0].IPAddress
  Ok "$HostIp ($($cfg.InterfaceAlias))"

  Step 'Telling Lumio'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  if ($Scheme -eq 'https') {
    # Trust exactly Lumio's certificate (pinned SHA-256), nothing else.
    [Net.ServicePointManager]::ServerCertificateValidationCallback = {
      param($s, $c, $ch, $e)
      $h = [Security.Cryptography.SHA256]::Create().ComputeHash($c.GetRawCertData())
      return (([BitConverter]::ToString($h)) -replace '-', ':') -eq $global:LumioFp
    }
  }
  $body = @{ token = $Token; hostIp = $HostIp } | ConvertTo-Json -Compress
  try {
    $r = Invoke-RestMethod -Method Post -Uri "$($Scheme)://$($VmIp):$Port/api/host-report" -ContentType 'application/json' -Body $body -TimeoutSec 15
    if ($r.pending) { Warn "Lumio received this PC's address. Confirm it once in the Lumio admin console (Overview -> Apply)." }
    else { Ok 'Lumio updated its address and certificate' }
  } catch {
    Warn "Couldn't reach Lumio automatically ($($_.Exception.Message)). Enter $HostIp in the Lumio admin console -> Network & Security."
  }

  Write-Host ''
  Write-Host '  All set!  On your phone, TV or tablet open:' -ForegroundColor Cyan
  Write-Host "      $($Scheme)://$($HostIp):$Port" -ForegroundColor White
  Write-Host '  (first time: accept the certificate warning, then sign in)' -ForegroundColor DarkGray
  Write-Host '  To remove these changes later, download the helper again and choose Undo.' -ForegroundColor DarkGray
  Offer-SelfDelete
} catch {
  Write-Host ''
  Write-Host "  Setup failed: $($_.Exception.Message)" -ForegroundColor Red
}
Write-Host ''
Read-Host '  Press Enter to close' | Out-Null
exit $global:LumioExit
`;
  const cmd = [
    '@echo off',
    'rem Lumio - Windows setup helper (generated by your Lumio server).',
    'rem Adds a VMware NAT port forward and a home-network-only firewall rule.',
    'rem Writes no logs, backups, temp files or PowerShell caches; can undo itself.',
    'setlocal',
    'set "PSModuleAnalysisCachePath=NUL"',
    'set "POWERSHELL_TELEMETRY_OPTOUT=1"',
    'net session >nul 2>&1 || (powershell -NoProfile -NonInteractive -Command "Start-Process -FilePath \'%~f0\' -Verb RunAs" & exit /b)',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=[IO.File]::ReadAllText(\'%~f0\'); iex $s.Substring($s.LastIndexOf(\'#__LUMIO_PS__\') + 13)"',
    'if not errorlevel 10 exit /b',
    'rem The user chose "delete this helper": remove this file after the script ends.',
    '(goto) 2>nul & del /f /q "%~f0"',
    'exit /b',
    '#__LUMIO_PS__',
    ps.trim(),
    '',
  ].join('\r\n');
  return cmd.replace(/\r?\n/g, '\r\n');
}

module.exports = { buildWindowsHelper };
