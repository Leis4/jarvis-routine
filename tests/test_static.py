from pathlib import Path
import re, json
root=Path(__file__).resolve().parents[1]
s=(root/'site/index.html').read_text(encoding='utf-8')
assert '<script src="smart.js?v=2"></script><script src="ai.js?v=2"></script>' in s
assert '<link rel="stylesheet" href="ai.css?v=2">' in s
assert 'const PLANS=' in s or 'let PLANS=' in s
assert (root/'backend/migrations/0001_initial.sql').exists()
assert 'QWEN_API_KEY' not in s
assert 'APP_ACCESS_TOKEN' not in s
assert 'API_SECRET' not in s
assert 'Bearer ' not in s
print('PASS: shell loaded, AI UI, secret values absent')
