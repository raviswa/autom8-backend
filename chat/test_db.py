import os
import requests
from dotenv import load_dotenv

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

if __name__ == '__main__':
    main()
