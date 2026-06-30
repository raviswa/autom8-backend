'use strict';

require('dotenv').config();

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function buildWebhookPayload({ from, phoneNumberId, message }) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: process.env.WHATSAPP_PHONE_NUMBER || '0000000000',
                phone_number_id: phoneNumberId,
              },
              contacts: [{ wa_id: from, profile: { name: 'Sim User' } }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

async function postWebhook(baseUrl, payload) {
  const endpoint = `${baseUrl.replace(/\/$/, '')}/api/whatsapp/webhook`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text().catch(() => '');
  return { status: res.status, text };
}

function makeLocationMessage({ from, lat, lng }) {
  return {
    from,
    id: `sim_loc_${Date.now()}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: 'location',
    location: {
      latitude: Number(lat),
      longitude: Number(lng),
      name: 'Simulated Pin',
      address: 'Simulated Address Label',
    },
  };
}

function makeListReplyMessage({ from, replyId }) {
  return {
    from,
    id: `sim_list_${Date.now()}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: 'interactive',
    interactive: {
      type: 'list_reply',
      list_reply: {
        id: replyId,
        title: replyId,
      },
    },
  };
}

function makeTextMessage({ from, text }) {
  return {
    from,
    id: `sim_text_${Date.now()}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: 'text',
    text: { body: text },
  };
}

function usage() {
  console.log('Usage examples:');
  console.log('  node scripts/simulateLocationFlow.js --mode location --from 919500000000 --lat 13.066 --lng 80.242 --phoneNumberId 123456 --baseUrl http://localhost:3001');
  console.log('  node scripts/simulateLocationFlow.js --mode select --from 919500000000 --replyId addr_0 --phoneNumberId 123456');
  console.log('  node scripts/simulateLocationFlow.js --mode custom --from 919500000000 --text "3/46, MahaLakshmi Nagar, Chennai" --phoneNumberId 123456');
}

async function main() {
  const args = parseArgs(process.argv);
  const mode = String(args.mode || '').toLowerCase();
  const baseUrl = args.baseUrl || process.env.SIM_BASE_URL || 'http://localhost:3001';
  const from = String(args.from || process.env.SIM_FROM || '').trim();
  const phoneNumberId = String(args.phoneNumberId || process.env.SIM_PHONE_NUMBER_ID || '').trim();

  if (!mode || !from || !phoneNumberId) {
    usage();
    process.exit(1);
  }

  let message;
  if (mode === 'location') {
    const lat = args.lat ?? process.env.SIM_LAT;
    const lng = args.lng ?? process.env.SIM_LNG;
    if (lat == null || lng == null) {
      console.error('[simulate] location mode requires --lat and --lng');
      process.exit(1);
    }
    message = makeLocationMessage({ from, lat, lng });
  } else if (mode === 'select') {
    const replyId = String(args.replyId || 'addr_0');
    message = makeListReplyMessage({ from, replyId });
  } else if (mode === 'custom') {
    const text = String(args.text || '').trim();
    if (!text) {
      console.error('[simulate] custom mode requires --text');
      process.exit(1);
    }
    message = makeTextMessage({ from, text });
  } else {
    console.error('[simulate] unsupported mode:', mode);
    usage();
    process.exit(1);
  }

  const payload = buildWebhookPayload({ from, phoneNumberId, message });
  const result = await postWebhook(baseUrl, payload);
  console.log(`[simulate] mode=${mode} status=${result.status} response=${result.text}`);
}

main().catch((err) => {
  console.error('[simulate] fatal:', err.message);
  process.exit(1);
});
