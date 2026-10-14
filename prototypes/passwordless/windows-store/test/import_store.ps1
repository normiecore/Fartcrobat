# Test-only: fill the .NET-managed CurrentUser\My store (on Linux: ~/.dotnet/corefx/cryptography/x509stores/my)
# with the fixture identities, and CurrentUser\AddressBook with the colleague's public certificate.
# Usage: pwsh -NoProfile -File import_store.ps1 <pki dir>
param([string]$Pki)
$ErrorActionPreference = 'Stop'
$X509 = 'System.Security.Cryptography.X509Certificates'
$flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]'PersistKeySet, Exportable'

$my = New-Object "$X509.X509Store" 'My', 'CurrentUser'
$my.Open('ReadWrite')
foreach ($name in 'recipient', 'me-enc', 'me-sign', 'me-noku', 'me-ec', 'me-expired') {
  $c = New-Object "$X509.X509Certificate2" (Join-Path $Pki "$name.p12"), 'test', $flags
  $my.Add($c)
  Write-Output ("My        + {0}  key={1}  {2}" -f $c.Thumbprint, $c.HasPrivateKey, $c.Subject)
}
$nokey = New-Object "$X509.X509Certificate2" (, [IO.File]::ReadAllBytes((Join-Path $Pki 'me-nokey.cer')))
$my.Add($nokey)
Write-Output ("My        + {0}  key={1}  {2}" -f $nokey.Thumbprint, $nokey.HasPrivateKey, $nokey.Subject)
$my.Close()

$ab = New-Object "$X509.X509Store" 'AddressBook', 'CurrentUser'
$ab.Open('ReadWrite')
$col = New-Object "$X509.X509Certificate2" (, [IO.File]::ReadAllBytes((Join-Path $Pki 'colleague.cer')))
$ab.Add($col)
Write-Output ("AddrBook  + {0}  key={1}  {2}" -f $col.Thumbprint, $col.HasPrivateKey, $col.Subject)
$ab.Close()
