import os
import requests
from dotenv import load_dotenv
from tools.feature_gate import build_service_selection_payload

load_dotenv('../.env')

def main():
    url = os.getenv("AUTOM8_SUPABASE_URL") or os.getenv("SUPABASE_URL")
    key = os.getenv("AUTOM8_SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        print("Supabase credentials not found in env!")
        return

    print("Supabase URL:", url)
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
    }
    
    # Let's get one row with all columns to see the columns of the restaurants table!
    endpoint = f"{url.rstrip('/')}/rest/v1/restaurants?limit=1"
    try:
        resp = requests.get(endpoint, headers=headers, verify=False) # disable SSL verify if cert is issue
        if resp.status_code == 200:
            data = resp.json()
            if data:
                print("Successfully retrieved a restaurant row!")
                print("Columns in restaurants table:")
                print(sorted(list(data[0].keys())))
            else:
                print("No restaurants found in the table.")
        else:
            print(f"Error {resp.status_code}: {resp.text}")
    except Exception as e:
        print("Request failed:", e)

def _row_ids(payload: dict) -> list[str]:
    sections = payload["interactive"]["action"]["sections"]
    return [row["id"] for section in sections for row in section["rows"]]

def test_service_selection_payload_full_service():
    restaurant = {
        "services_enabled": ["dine_in", "takeaway", "delivery"],
        "scheduled_delivery_enabled": True,
        "scheduled_takeaway_enabled": True,
    }

    payload = build_service_selection_payload(restaurant)

    assert payload is not None
    assert payload["type"] == "interactive"

    sections = payload["interactive"]["action"]["sections"]
    assert len(sections) == 2
    assert sections[0]["title"] == "🚀 INSTANT / NOW"
    assert sections[1]["title"] == "⏰ PLANNED / LATER"

    rows = _row_ids(payload)
    assert set(rows) == {
        "dine_in_now",
        "door_delivery_now",
        "takeaway_now",
        "table_reservation",
        "scheduled_delivery",
        "scheduled_pickup",
    }
    assert len(rows) == 6


def test_service_selection_payload_delivery_only():
    restaurant = {
        "services_enabled": ["delivery"],
        "scheduled_delivery_enabled": False,
        "scheduled_takeaway_enabled": False,
    }

    payload = build_service_selection_payload(restaurant)

    assert payload is not None
    assert payload["type"] == "interactive"

    sections = payload["interactive"]["action"]["sections"]
    assert len(sections) == 1
    assert sections[0]["title"] == "🚀 INSTANT / NOW"
    assert [row["id"] for row in sections[0]["rows"]] == ["door_delivery_now"]


def test_service_selection_payload_takeaway_with_scheduled_pickup():
    restaurant = {
        "services_enabled": ["takeaway"],
        "scheduled_delivery_enabled": False,
        "scheduled_takeaway_enabled": True,
    }

    payload = build_service_selection_payload(restaurant)

    assert payload is not None
    assert payload["type"] == "interactive"

    sections = payload["interactive"]["action"]["sections"]
    assert len(sections) == 2
    assert [row["id"] for row in sections[0]["rows"]] == ["takeaway_now"]
    assert [row["id"] for row in sections[1]["rows"]] == ["scheduled_pickup"]


def test_service_selection_payload_zero_rows_returns_text():
    restaurant = {
        "services_enabled": [],
        "scheduled_delivery_enabled": False,
        "scheduled_takeaway_enabled": False,
    }

    payload = build_service_selection_payload(restaurant)

    assert payload["type"] == "text"
    assert "not accepting orders right now" in payload["text"]["body"]

if __name__ == '__main__':
    main()
