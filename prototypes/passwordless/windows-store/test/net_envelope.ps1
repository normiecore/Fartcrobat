# Test-only: make EnvelopedData with .NET for one recipient certificate, to cross-check decryption.
# Usage: pwsh -NoProfile -File net_envelope.ps1 <cert.cer> <ski|issuer> <pkcs1|oaep256> <content hex>
# Prints the DER as base64. Uses explicit AES-256-CBC (the .NET Framework default is 3DES).
param([string]$CertPath, [string]$IdType, [string]$Padding, [string]$Hex)
$ErrorActionPreference = 'Stop'
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (, [IO.File]::ReadAllBytes($CertPath))
$bytes = [byte[]]@(for ($i = 0; $i -lt $Hex.Length; $i += 2) { [Convert]::ToByte($Hex.Substring($i, 2), 16) })
$ci = New-Object System.Security.Cryptography.Pkcs.ContentInfo (, $bytes)
$alg = New-Object System.Security.Cryptography.Pkcs.AlgorithmIdentifier (New-Object System.Security.Cryptography.Oid '2.16.840.1.101.3.4.1.42')
$cms = New-Object System.Security.Cryptography.Pkcs.EnvelopedCms $ci, $alg
$sit = if ($IdType -eq 'ski') { 'SubjectKeyIdentifier' } else { 'IssuerAndSerialNumber' }
if ($Padding -eq 'oaep256') {
  # .NET Core 3.0+ only; .NET Framework (Windows PowerShell 5.1) has no OAEP choice when encrypting
  $rcp = New-Object System.Security.Cryptography.Pkcs.CmsRecipient $sit, $cert, ([System.Security.Cryptography.RSAEncryptionPadding]::OaepSHA256)
} else {
  $rcp = New-Object System.Security.Cryptography.Pkcs.CmsRecipient $sit, $cert
}
$cms.Encrypt($rcp)
[Console]::Out.WriteLine([Convert]::ToBase64String($cms.Encode()))
