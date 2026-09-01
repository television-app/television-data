import json
import os
import sys
import base64
import requests
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad

sys.stdout.reconfigure(encoding='utf-8')

TURSO_URL = "https://television-db-nmalifkhan.aws-ap-south-1.turso.io/v2/pipeline"
TURSO_TOKEN = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODY4MTIwNDMsImlkIjoiMDFhMDA2NGEtMDQwMS03YTU3LTkxZjYtMGU1ZTZlOWMxNjNiIiwia2lkIjoiZHduMVdVSThoakdUUlZYbHI3d0FnR1Z3WnJfaDRVU2xvY3paWERaNmdwbyIsInJpZCI6ImUzYjg3YjQ4LTExNmItNGYyZi1iNzIzLTliZWMzODdhNTZhNSJ9.6ZCMp8BlhqEXnXpTkMoreyxT6oFgVGlEMzPKysiSMBPvPFXwvG87S8UVJe5OEunquitiz_S1xA6cG7UXPyL5Dw"
ENCRYPTION_KEY = "T3l3v1s10n_S3cr3t_K3y_2026_@ppX"

def encrypt_data(data_string, key_string):
    key = key_string.encode('utf-8')[:32].ljust(32, b'\0')
    iv = os.urandom(16)
    cipher = AES.new(key, AES.MODE_CBC, iv)
    encrypted_bytes = cipher.encrypt(pad(data_string.encode('utf-8'), AES.block_size))
    payload = iv + encrypted_bytes
    return base64.b64encode(payload).decode('utf-8')

def sync_turso_to_playlists():
    print("1. Fetching all channels from Turso DB...")
    req = {
        "requests": [
            {"type": "execute", "stmt": {"sql": "SELECT id, number, name, logo, stream_url, category, user_agent, referer, edge_policy, headers, backup_urls, status FROM channels ORDER BY CAST(number AS INTEGER) ASC;"}},
            {"type": "close"}
        ]
    }
    headers = {"Authorization": f"Bearer {TURSO_TOKEN}", "Content-Type": "application/json"}
    r = requests.post(TURSO_URL, headers=headers, json=req)
    res_data = r.json()
    rows = res_data["results"][0]["response"]["result"]["rows"]
    print(f"Total rows fetched from Turso: {len(rows)}")

    playlist_plain = []
    for idx, r_row in enumerate(rows):
        vals = [cell.get("value") for cell in r_row]
        cid = vals[0]
        num = vals[1] if vals[1] is not None else idx
        name = vals[2] or f"Channel {idx}"
        logo = vals[3] or ""
        url = vals[4] or ""
        cat = vals[5] or "ALL"
        status_val = vals[11] if len(vals) > 11 else "active"
        is_active = status_val.lower() == "active"

        if not url:
            continue

        playlist_plain.append({
            "i": f"ch_{idx}",
            "n": name,
            "l": logo,
            "u": url,
            "bu": "",
            "c": cat,
            "no": idx,
            "active": is_active
        })

    print(f"Valid active channels for playlist: {len(playlist_plain)}")

    # Encrypt and write playlist.json
    json_str = json.dumps(playlist_plain, ensure_ascii=False)
    encrypted_str = encrypt_data(json_str, ENCRYPTION_KEY)

    with open("playlist.json", "w", encoding="utf-8") as f:
        f.write(encrypted_str)

    print("✅ Successfully updated encrypted playlist.json!")

if __name__ == "__main__":
    sync_turso_to_playlists()
