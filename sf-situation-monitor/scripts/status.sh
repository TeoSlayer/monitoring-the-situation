#!/bin/bash
# Quick status check for the SF Situation Monitor
# Usage: ./status.sh [base_url]
BASE="${1:-http://localhost:8766}"

echo "=== System Status ==="
curl -s "$BASE/api/status" | python3 -m json.tool 2>/dev/null || echo "Backend not reachable at $BASE"

echo ""
echo "=== Active Incidents ==="
curl -s "$BASE/api/incidents" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if data.get('ok'):
    print(f\"Total: {data['total']}\")
    for inc in data.get('data', [])[:5]:
        sev = inc.get('severity', '?')
        title = inc.get('title', inc.get('type', 'unknown'))
        print(f'  [{sev.upper()}] {title}')
" 2>/dev/null

echo ""
echo "=== Recent Radio (last 5) ==="
curl -s "$BASE/api/radio/recent?limit=5" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if data.get('ok'):
    for msg in data.get('data', []):
        tag = msg.get('talkgroup_tag', '?')
        text = msg.get('transcript', '')[:80]
        print(f'  [{tag}] {text}')
" 2>/dev/null
