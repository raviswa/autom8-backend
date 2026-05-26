# Procfile — Railway uses this to start both processes from one deployment.
#
# 'web'  — Node.js POS backend (existing server.js). Handles all HTTP + WS.
# 'chat' — Python FastAPI chat bot (munafe repo, now lives in chat/ subfolder).
#           Runs on internal port 8001 — never exposed publicly.
#           Node proxies WhatsApp webhooks to it via localhost:8001.
#
# Railway starts both processes automatically on deploy.
# If you only want to run Node for now, comment out the chat line.

web: node server.js
chat: cd chat && pip install -r requirements.txt -q && uvicorn main:app --host 0.0.0.0 --port 8001
