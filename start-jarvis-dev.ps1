$ErrorActionPreference = "SilentlyContinue"

if (-not (Get-Process -Name "ollama*")) {
    Start-Process "ollama" -ArgumentList "serve" -WindowStyle Hidden
    Start-Sleep -Seconds 2
}

$proxyUp = Test-NetConnection -ComputerName 127.0.0.1 -Port 4000 -InformationLevel Quiet
if (-not $proxyUp) {
    Start-Process "node" -ArgumentList "tools/aitunnel-cache-proxy.mjs" -WindowStyle Hidden
    Start-Sleep -Seconds 1
}

if ($env:JARVIS_RAG_AUTO_INDEX -eq "1") { node tools/rag-search.mjs --index-only }
Write-Host "Local AI Stack Ready (Ollama on demand; RAG index only if JARVIS_RAG_AUTO_INDEX=1; Proxy :4000)" -ForegroundColor Green
opencode
