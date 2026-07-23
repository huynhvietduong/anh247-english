# Deploy EnglishDaily len VPS (ASCII-only - tranh bay PS 5.1 doc sai UTF-8)
# Cach dung:  .\deploy.ps1 "noi dung sua"
param([string]$Msg = "update")
$VPS = "root@103.126.161.126"

git add -A
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { git commit -m $Msg }

git push origin main
if ($LASTEXITCODE -ne 0) { Write-Host "LOI: push GitHub that bai"; exit 1 }

ssh $VPS "bash /root/update-anh247.sh"
if ($LASTEXITCODE -ne 0) { Write-Host "LOI: update tren VPS that bai"; exit 1 }

Write-Host "OK: Deploy xong -> https://anh247.id.vn"
