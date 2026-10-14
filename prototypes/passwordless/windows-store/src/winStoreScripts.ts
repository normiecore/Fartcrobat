// PowerShell sources for the Windows certificate store helper (see winCertStore.ts).
//
// Rules for these strings, checked by test/winstore.test.ts:
// - They must run unchanged on Windows PowerShell 5.1 (.NET Framework 4.x) and PowerShell 7: no `??`,
//   `?.`, ternaries, `&&`, `-AsArray`, `-AsHashtable`, and no Cert: drive (pwsh on Linux has none).
// - ASCII only, no backtick and no dollar-brace, so they embed in String.raw template literals.
// - All inputs reach the script as base64 or as validated literals built by buildScript(), so nothing a
//   user typed is ever parsed as PowerShell.
// - The only stdout the caller reads is one line starting with FCJSON: (ASCII-only JSON). The script
//   never touches the private key except through EnvelopedCms.Decrypt, never exports keys, and never
//   writes files.

/** Runs first: refuses in Constrained Language Mode, then defines the JSON writer and error mapping. */
export const PRELUDE = String.raw`
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Write-Output ('FCJSON:{"ok":false,"code":"CONSTRAINED_LANGUAGE","languageMode":"' + $ExecutionContext.SessionState.LanguageMode + '"}')
  return
}
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$X = 'System.Security.Cryptography.X509Certificates'
$FcEsc = [System.Text.RegularExpressions.MatchEvaluator] {
  param($m)
  $c = [int][char]$m.Value
  if ($c -eq 34) { return '\"' }
  if ($c -eq 92) { return '\\' }
  return '\u' + $c.ToString('x4')
}
function ConvertTo-FcJson($v) {
  if ($null -eq $v) { return 'null' }
  if ($v -is [bool]) { if ($v) { return 'true' }; return 'false' }
  if ($v -is [int] -or $v -is [long]) { return [string]$v }
  if ($v -is [string]) { return '"' + [regex]::Replace($v, '[\x00-\x1f"\\\x7f-\uffff]', $FcEsc) + '"' }
  if ($v -is [System.Collections.IDictionary]) {
    $parts = foreach ($k in $v.Keys) { (ConvertTo-FcJson ([string]$k)) + ':' + (ConvertTo-FcJson $v[$k]) }
    return '{' + (@($parts) -join ',') + '}'
  }
  if ($v -is [System.Collections.IEnumerable]) {
    $parts = foreach ($x in $v) { ConvertTo-FcJson $x }
    return '[' + (@($parts) -join ',') + ']'
  }
  return ConvertTo-FcJson ([string]$v)
}
function Write-FcResult($obj) {
  [Console]::Out.WriteLine('FCJSON:' + (ConvertTo-FcJson $obj))
  [Console]::Out.Flush()
}
# HRESULTs from winerror.h that the decrypt path can raise on Windows.
$FcCodes = @{
  '8009100B' = 'NO_MATCHING_CERT'
  '8010006E' = 'CANCELLED'
  '800704C7' = 'CANCELLED'
  '8010006B' = 'WRONG_PIN'
  '8010006C' = 'PIN_BLOCKED'
  '8010000C' = 'CARD_NOT_PRESENT'
  '80100069' = 'CARD_NOT_PRESENT'
  '8010002E' = 'CARD_NOT_PRESENT'
  '80090016' = 'KEY_UNAVAILABLE'
  '8009000D' = 'KEY_UNAVAILABLE'
  '80090010' = 'KEY_ACCESS_DENIED'
  '80090022' = 'UI_REQUIRED'
  '80090005' = 'DECRYPT_FAILED'
}
function Get-FcError($err) {
  $e = $err.Exception
  $found = $null
  while ($null -ne $e) {
    if ($e -is [System.Security.Cryptography.CryptographicException] -or $e -is [System.PlatformNotSupportedException]) { $found = $e }
    $e = $e.InnerException
  }
  if ($null -eq $found) {
    $found = $err.Exception
    while ($null -ne $found.InnerException) { $found = $found.InnerException }
  }
  $hex = '{0:X8}' -f $found.HResult
  $code = $FcCodes[$hex]
  if ($null -eq $code) {
    if ($found -is [System.PlatformNotSupportedException]) { $code = 'UNSUPPORTED' } else { $code = 'ERROR' }
  }
  return [ordered]@{ code = $code; hresult = '0x' + $hex; type = $found.GetType().FullName; message = $found.Message }
}
if (-not ('System.Security.Cryptography.Pkcs.EnvelopedCms' -as [type])) {
  try { Add-Type -AssemblyName System.Security } catch { }
}
if (-not ('System.Security.Cryptography.Pkcs.EnvelopedCms' -as [type])) {
  Add-Type -AssemblyName System.Security.Cryptography.Pkcs
}
`

/**
 * Inputs: $Blobs (base64 PKCS#7 EnvelopedData, in /Recipients order), $Mode ('probe' or 'decrypt'),
 * $Thumbprint ('' or the SHA-1 thumbprint of the only certificate to use).
 * probe: says which of the person's certificates (with a private key) match a recipient, without using
 *        any key, so it never shows a PIN prompt.
 * decrypt: decrypts the first matching recipient with EnvelopedCms (Windows asks for a smart card PIN
 *        itself) and returns ContentInfo.Content (for PubSec: 20-byte seed + 4 permission bytes).
 */
export const DECRYPT_BODY = String.raw`
function Get-FcSerialKeys([string]$hex) {
  $h = ($hex -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
  if ($h.Length % 2) { $h = '0' + $h }
  $pairs = @(for ($i = 0; $i -lt $h.Length; $i += 2) { $h.Substring($i, 2) })
  $be = (($pairs -join '') -replace '^(00)+(?=.)', '')
  [array]::Reverse($pairs)
  $le = (($pairs -join '') -replace '^(00)+(?=.)', '')
  return @($be, $le)
}
# Key identifiers a recipient may use for this certificate: the SubjectKeyIdentifier extension, SHA-1 of
# the whole SubjectPublicKeyInfo (what .NET writes, and CAPI computes, when the extension is missing) and
# SHA-1 of the key bits (RFC 5280 method 1). .NET Framework cannot export the SPKI, so rebuild its DER.
function Get-FcDer([int]$tag, [byte[]]$content) {
  $n = $content.Length
  if ($n -lt 128) { $len = @($n) } else {
    $len = @()
    while ($n -gt 0) { $len = @($n -band 255) + $len; $n = $n -shr 8 }
    $len = @(128 + $len.Count) + $len
  }
  return ,([byte[]](@($tag) + $len + $content))
}
$FcAlgOids = @{
  '1.2.840.113549.1.1.1' = [byte[]](6, 9, 42, 134, 72, 134, 247, 13, 1, 1, 1)
  '1.2.840.10045.2.1' = [byte[]](6, 7, 42, 134, 72, 206, 61, 2, 1)
}
function Get-FcSkis($cert) {
  $out = @()
  foreach ($ext in $cert.Extensions) {
    if ($ext -is [System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]) { $out += $ext.SubjectKeyIdentifier.ToUpperInvariant() }
  }
  $sha1 = [System.Security.Cryptography.SHA1]::Create()
  $pk = $cert.PublicKey
  $keyBits = [byte[]]$pk.EncodedKeyValue.RawData
  $out += ([BitConverter]::ToString($sha1.ComputeHash($keyBits)) -replace '-', '')
  $oid = $FcAlgOids[$pk.Oid.Value]
  if ($null -ne $oid) {
    $algId = Get-FcDer 48 ([byte[]]($oid + [byte[]]$pk.EncodedParameters.RawData))
    $bits = Get-FcDer 3 ([byte[]](@(0) + $keyBits))
    $spki = Get-FcDer 48 ([byte[]]($algId + $bits))
    $out += ([BitConverter]::ToString($sha1.ComputeHash($spki)) -replace '-', '')
  }
  return $out
}
function Get-FcNorm([string]$s) { return ($s -replace '\s+', '').ToUpperInvariant() }

$storeErrors = New-Object System.Collections.ArrayList
$owned = New-Object System.Collections.ArrayList
$opened = New-Object System.Collections.ArrayList
foreach ($loc in 'CurrentUser', 'LocalMachine') {
  try {
    $st = New-Object "$X.X509Store" 'My', $loc
    $st.Open([System.Security.Cryptography.X509Certificates.OpenFlags]'ReadOnly, OpenExistingOnly, IncludeArchived')
    [void]$opened.Add($st)
    foreach ($c in $st.Certificates) {
      if (-not $c.HasPrivateKey) { continue }
      if ($Thumbprint -and $c.Thumbprint -ne $Thumbprint) { continue }
      [void]$owned.Add(@{ cert = $c; store = $loc + '\My'; serials = (Get-FcSerialKeys $c.SerialNumber); skis = @(Get-FcSkis $c) })
    }
  } catch {
    $fe = Get-FcError $_
    [void]$storeErrors.Add([ordered]@{ store = $loc + '\My'; code = $fe.code; message = $fe.message })
  }
}

$recipients = New-Object System.Collections.ArrayList
$candidates = New-Object System.Collections.ArrayList
for ($b = 0; $b -lt $Blobs.Count; $b++) {
  $cms = New-Object System.Security.Cryptography.Pkcs.EnvelopedCms
  try {
    $cms.Decode([Convert]::FromBase64String($Blobs[$b]))
  } catch {
    $fe = Get-FcError $_
    [void]$recipients.Add([ordered]@{ blob = $b; index = -1; error = 'BAD_BLOB'; message = $fe.message })
    continue
  }
  for ($r = 0; $r -lt $cms.RecipientInfos.Count; $r++) {
    $ri = $cms.RecipientInfos[$r]
    $id = $ri.RecipientIdentifier
    $info = [ordered]@{ blob = $b; index = $r; type = [string]$ri.Type; idType = [string]$id.Type; keyEncryptionAlgorithm = $ri.KeyEncryptionAlgorithm.Oid.Value }
    $hits = @()
    if ([string]$id.Type -eq 'IssuerAndSerialNumber') {
      $info.issuer = $id.Value.IssuerName
      $info.serial = $id.Value.SerialNumber
      $want = @(Get-FcSerialKeys $id.Value.SerialNumber)
      foreach ($o in $owned) {
        if ($want -contains $o.serials[0]) {
          $hits += @{ o = $o; exact = ((Get-FcNorm $o.cert.Issuer) -eq (Get-FcNorm $id.Value.IssuerName)) }
        }
      }
    } elseif ([string]$id.Type -eq 'SubjectKeyIdentifier') {
      $info.ski = ([string]$id.Value).ToUpperInvariant()
      foreach ($o in $owned) {
        if ($o.skis -contains $info.ski) { $hits += @{ o = $o; exact = $true } }
      }
    }
    [void]$recipients.Add($info)
    foreach ($m in $hits) {
      [void]$candidates.Add(@{ blob = $b; index = $r; cms = $cms; ri = $ri; cert = $m.o.cert; store = $m.o.store; exact = $m.exact; seq = $candidates.Count })
    }
  }
}
# exact issuer matches first, then CurrentUser before LocalMachine; otherwise /Recipients order
$ordered = @($candidates | Sort-Object -Property @{ Expression = { -not $_.exact } }, @{ Expression = { $_.store -ne 'CurrentUser\My' } }, @{ Expression = { $_.seq } })
$candOut = @(foreach ($c in $ordered) {
  [ordered]@{ blob = $c.blob; index = $c.index; store = $c.store; thumbprint = $c.cert.Thumbprint; subject = $c.cert.Subject; notAfter = $c.cert.NotAfter.ToUniversalTime().ToString('o'); issuerMatch = $c.exact }
})

if ($ordered.Count -eq 0) {
  Write-FcResult ([ordered]@{ ok = $false; code = 'NO_MATCHING_CERT'; recipients = $recipients; storeErrors = $storeErrors })
} elseif ($Mode -eq 'probe') {
  Write-FcResult ([ordered]@{ ok = $true; mode = 'probe'; candidates = $candOut; recipients = $recipients; storeErrors = $storeErrors })
} else {
  $attempts = New-Object System.Collections.ArrayList
  $done = $false
  foreach ($c in $ordered) {
    try {
      $extra = New-Object "$X.X509Certificate2Collection"
      [void]$extra.Add($c.cert)
      $c.cms.Decrypt($c.ri, $extra)
      $content = $c.cms.ContentInfo.Content
      Write-FcResult ([ordered]@{
        ok = $true; mode = 'decrypt'; blob = $c.blob; index = $c.index; store = $c.store
        thumbprint = $c.cert.Thumbprint; subject = $c.cert.Subject
        contentEncryptionAlgorithm = $c.cms.ContentEncryptionAlgorithm.Oid.Value
        keyEncryptionAlgorithm = $c.ri.KeyEncryptionAlgorithm.Oid.Value
        content = [Convert]::ToBase64String($content); attempts = $attempts
      })
      $done = $true
      break
    } catch {
      $fe = Get-FcError $_
      if ($fe.code -eq 'ERROR' -and [string]$c.ri.Type -eq 'KeyAgreement') { $fe.code = 'UNSUPPORTED' }
      # serial matched but issuer did not, and the decrypter agreed it is not this recipient
      if ($fe.code -eq 'ERROR' -and -not $c.exact) { $fe.code = 'NO_MATCHING_CERT' }
      $fe.blob = $c.blob; $fe.index = $c.index; $fe.thumbprint = $c.cert.Thumbprint
      [void]$attempts.Add($fe)
      if (@('CANCELLED', 'WRONG_PIN', 'PIN_BLOCKED') -contains $fe.code) { break }
    }
  }
  if (-not $done) {
    Write-FcResult ([ordered]@{ ok = $false; code = $attempts[0].code; attempts = $attempts; recipients = $recipients; storeErrors = $storeErrors })
  }
}
foreach ($st in $opened) { $st.Close() }
`

/**
 * Input: $IncludeOthers (bool). Lists CurrentUser\My certificates that have a private key and whose key
 * usage allows encryption (RSA: keyEncipherment or dataEncipherment; EC: keyAgreement; or no key usage
 * extension), plus, with $IncludeOthers, every certificate in CurrentUser\AddressBook ("Other People").
 * Only public data is returned. HasPrivateKey reads a certificate property; it does not open the key, so
 * listing never prompts for a smart card.
 */
export const LIST_BODY = String.raw`
$out = New-Object System.Collections.ArrayList
$storeErrors = New-Object System.Collections.ArrayList
$specs = @(@{ name = 'My'; needKey = $true })
if ($IncludeOthers) { $specs += @{ name = 'AddressBook'; needKey = $false } }
foreach ($spec in $specs) {
  try {
    $st = New-Object "$X.X509Store" $spec.name, 'CurrentUser'
    $st.Open([System.Security.Cryptography.X509Certificates.OpenFlags]'ReadOnly, OpenExistingOnly')
  } catch {
    $fe = Get-FcError $_
    [void]$storeErrors.Add([ordered]@{ store = 'CurrentUser\' + $spec.name; code = $fe.code; message = $fe.message })
    continue
  }
  foreach ($c in $st.Certificates) {
    if ($spec.needKey -and -not $c.HasPrivateKey) { continue }
    $flags = -1
    $ekus = New-Object System.Collections.ArrayList
    foreach ($ext in $c.Extensions) {
      if ($ext -is [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]) { $flags = [int]$ext.KeyUsages }
      elseif ($ext -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]) {
        foreach ($oid in $ext.EnhancedKeyUsages) { [void]$ekus.Add($oid.Value) }
      }
    }
    $alg = $c.PublicKey.Oid.Value
    $usage = $null
    if ($alg -eq '1.2.840.113549.1.1.1') {
      if ($flags -eq -1) { $usage = 'unrestricted' } elseif ($flags -band 32) { $usage = 'keyEncipherment' } elseif ($flags -band 16) { $usage = 'dataEncipherment' }
    } elseif ($alg -eq '1.2.840.10045.2.1') {
      if ($flags -eq -1) { $usage = 'unrestricted' } elseif ($flags -band 8) { $usage = 'keyAgreement' }
    }
    if ($spec.needKey -and $null -eq $usage) { continue }
    [void]$out.Add([ordered]@{
      store = 'CurrentUser\' + $spec.name; thumbprint = $c.Thumbprint; subject = $c.Subject; issuer = $c.Issuer
      serial = $c.SerialNumber; notBefore = $c.NotBefore.ToUniversalTime().ToString('o'); notAfter = $c.NotAfter.ToUniversalTime().ToString('o')
      publicKeyAlgorithm = $alg; keyUsage = $flags; encryptionUsage = $usage; ekus = $ekus
      email = $c.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::EmailName, $false)
      friendlyName = $c.FriendlyName; hasPrivateKey = $c.HasPrivateKey; der = [Convert]::ToBase64String($c.RawData)
    })
  }
  $st.Close()
}
Write-FcResult ([ordered]@{ ok = $true; certificates = $out; storeErrors = $storeErrors })
`

/**
 * Input: $QueryB64 (UTF-8 text, base64). Looks people up in Active Directory (domain-joined Windows only)
 * by e-mail address or name prefix and returns their userCertificate values (DER) and
 * userSMIMECertificate values (PKCS#7, parsed by the caller). Not testable on Linux.
 */
export const DIRECTORY_BODY = String.raw`
Add-Type -AssemblyName System.DirectoryServices
$q = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($QueryB64))
$q = $q -replace '\\', '\5c' -replace '\*', '\2a' -replace '\(', '\28' -replace '\)', '\29' -replace ([string][char]0), '\00'
try {
  $s = New-Object System.DirectoryServices.DirectorySearcher
  $s.Filter = '(&(objectCategory=person)(objectClass=user)(|(mail=' + $q + ')(proxyAddresses=smtp:' + $q + ')(displayName=' + $q + '*)(cn=' + $q + '*)))'
  foreach ($p in 'displayName', 'mail', 'userCertificate', 'userSMIMECertificate') { [void]$s.PropertiesToLoad.Add($p) }
  $s.SizeLimit = 25
  $s.ClientTimeout = [TimeSpan]::FromSeconds(15)
  $people = New-Object System.Collections.ArrayList
  foreach ($res in $s.FindAll()) {
    $certs = @(foreach ($v in $res.Properties['usercertificate']) { [Convert]::ToBase64String([byte[]]$v) })
    $smime = @(foreach ($v in $res.Properties['usersmimecertificate']) { [Convert]::ToBase64String([byte[]]$v) })
    [void]$people.Add([ordered]@{
      displayName = [string]($res.Properties['displayname'] | Select-Object -First 1)
      mail = [string]($res.Properties['mail'] | Select-Object -First 1)
      userCertificate = $certs; userSMIMECertificate = $smime
    })
  }
  Write-FcResult ([ordered]@{ ok = $true; people = $people })
} catch {
  $fe = Get-FcError $_
  $fe.ok = $false
  if ($fe.code -eq 'ERROR') { $fe.code = 'DIRECTORY_UNAVAILABLE' }
  Write-FcResult $fe
}
`

/** A PowerShell single-quoted literal of a value that is already restricted to safe characters. */
function literal(value: string): string {
  if (!/^[A-Za-z0-9+/=_.-]*$/.test(value)) throw new Error('unsafe value for a PowerShell literal')
  return `'${value}'`
}

export type ScriptVars = Record<string, string | boolean | string[]>

/**
 * Wraps prelude + variables + body in one script block, as one stdin payload for
 * `powershell.exe -Command -`. Values are emitted as literals (strings must be base64-safe).
 */
export function buildScript(body: string, vars: ScriptVars): string {
  const assign = Object.entries(vars).map(([name, value]) => {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new Error(`bad variable name ${name}`)
    if (typeof value === 'boolean') return `$${name} = $${value ? 'true' : 'false'}`
    // one literal per line: no single huge line for the 5.1 console reader
    if (Array.isArray(value)) return [`$${name} = @(`, ...value.map(literal), ')'].join('\n')
    return `$${name} = ${literal(value)}`
  })
  // Blank lines would end the statement early in -Command - mode, and comments only cost bytes.
  const guarded = ['try {', body, '} catch {', '$fe = Get-FcError $_', '$fe.ok = $false', 'Write-FcResult $fe', '}']
  const lines = [PRELUDE, assign.join('\n'), ...guarded]
    .join('\n')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
  return `& {\n${lines.join('\n')}\n}\n\n`
}
