Location Flow Dev Helpers

1) Seed overlapping outlets

Command:
  npm run seed:outlets -- --restaurant <restaurant_uuid>

Optional args:
  --lat <decimal>      default 13.0660
  --lng <decimal>      default 80.2420
  --radius <km>        default 5
  --prefix <name>      default Test Outlet

This inserts two active outlets with overlapping radii so nearest-outlet selection can be validated.

2) Simulate webhook payloads for location flow

Set these once (or pass as args every call):
  SIM_BASE_URL=http://localhost:3001
  SIM_FROM=919500000000
  SIM_PHONE_NUMBER_ID=<meta_phone_number_id>

A) Share location pin
Command:
  npm run simulate:location-flow -- --mode location --from 919500000000 --lat 13.066 --lng 80.242 --phoneNumberId <meta_phone_number_id>

B) Select address option from list
Command:
  npm run simulate:location-flow -- --mode select --from 919500000000 --replyId addr_0 --phoneNumberId <meta_phone_number_id>

C) Type custom address
Command:
  npm run simulate:location-flow -- --mode custom --from 919500000000 --text "3/46, MahaLakshmi Nagar, Iyyappanthangal, Chennai" --phoneNumberId <meta_phone_number_id>

Notes:
- The webhook responds immediately with EVENT_RECEIVED (HTTP 200); actual bot behavior is visible in server logs and outgoing WhatsApp API logs.
- Use the same --from number across steps to stay in one conversation session.
- To test re-share behavior, run mode=location twice with different lat/lng.
