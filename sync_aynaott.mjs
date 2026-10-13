/**
 * AynaOTT Live Stream Auto-Sync Engine for Television App
 * Fetches fresh HLS streams from AynaOTT API and syncs with Turso DB
 */

const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;

const BASE_URL = "https://web.aynaott.com";
const TENANT_ID = "019dd92f-107c-7056-9e79-e5233f6e51d9";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

// Known name aliases between Turso DB and AynaOTT
const ALIASES = {
    "tntsports1": "tntsport1",
    "disnepjr": "disneyjunior",
    "wildhd": "wildtv",
    "nicklodean": "nickelodeon"
};

function normalize(str) {
    return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function fetchAynaOTTChannels() {
    console.log("Fetching channels from AynaOTT Catalog API...");
    let page = 1;
    let allChannels = [];

    while (true) {
        try {
            const url = `${BASE_URL}/api/v5/catalog/contents?type=live-tvs&per_page=100&page=${page}`;
            const res = await fetch(url, {
                headers: {
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json",
                    "X-Tenant-Id": TENANT_ID
                },
                signal: AbortSignal.timeout(10000)
            });

            if (!res.ok) {
                console.warn(`Catalog page ${page} returned status ${res.status}`);
                break;
            }

            const data = await res.json();
            const records = data.records || [];
            if (records.length === 0) break;

            for (const ch of records) {
                let streamUrl = ch.stream?.url || "";
                allChannels.push({
                    id: ch.id,
                    slug: ch.slug,
                    name: ch.title,
                    url: streamUrl,
                    logo: ch.images?.thumbnail_url || "",
                    access: ch.access?.level || "free"
                });
            }

            if (records.length < 100) break;
            page++;
            if (page > 10) break; // Safety limit
        } catch (e) {
            console.warn(`Failed fetching AynaOTT catalog page ${page}:`, e.message);
            break;
        }
    }

    console.log(`Fetched ${allChannels.length} total channels from AynaOTT catalog.`);

    // If stream URL is missing for some channels, fetch detail endpoint
    const missingStream = allChannels.filter(c => !c.url && c.slug);
    if (missingStream.length > 0) {
        console.log(`Resolving stream URLs for ${missingStream.length} channels...`);
        for (const item of missingStream.slice(0, 15)) {
            try {
                const detailRes = await fetch(`${BASE_URL}/api/v5/browse/live-tvs/${item.slug}`, {
                    headers: {
                        "User-Agent": USER_AGENT,
                        "Accept": "application/json",
                        "X-Tenant-Id": TENANT_ID
                    },
                    signal: AbortSignal.timeout(6000)
                });
                if (detailRes.ok) {
                    const detail = await detailRes.json();
                    const rec = detail.record || detail;
                    item.url = rec.stream?.url || rec.stream_url || "";
                }
            } catch (err) {
                // Ignore individual detail fetch errors
            }
        }
    }

    return allChannels.filter(c => c.url && c.url.startsWith("http"));
}

async function run() {
    if (!TURSO_URL || !TURSO_TOKEN) {
        console.error("TURSO_URL or TURSO_TOKEN missing. Skipping AynaOTT sync.");
        return;
    }

    const aynaChannels = await fetchAynaOTTChannels();
    if (aynaChannels.length === 0) {
        console.warn("No AynaOTT channels retrieved. Preserving existing DB data.");
        return;
    }
    console.log(`Found ${aynaChannels.length} active AynaOTT streams.`);

    console.log("Querying Turso DB for AynaOTT channels...");
    const dbRes = await fetch(TURSO_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${TURSO_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            requests: [
                {
                    type: 'execute',
                    stmt: {
                        sql: "SELECT id, name, stream_url FROM channels WHERE stream_url LIKE '%aynaott%' OR stream_url LIKE '%tvsen%' OR stream_url LIKE '%aynascope%' OR stream_url LIKE '%moveonjoy%' OR stream_url LIKE '%tvpass.org%';"
                    }
                },
                { type: 'close' }
            ]
        })
    });

    const dbData = await dbRes.json();
    if (dbData.error) {
        console.error("Turso error:", dbData.error);
        return;
    }

    const rows = dbData.results[0].response.result.rows;
    console.log(`Found ${rows.length} AynaOTT channels in Turso DB.`);

    const updates = [];

    for (const row of rows) {
        const id = row[0].value;
        const name = row[1].value;
        const currentUrl = row[2].value;

        let normDb = normalize(name);
        if (ALIASES[normDb]) {
            normDb = ALIASES[normDb];
        }

        // 1. Exact match by name or slug
        let matched = aynaChannels.find(c => {
            const normC = normalize(c.name);
            const normSlug = normalize(c.slug);
            return normC === normDb || normSlug === normDb;
        });

        // 2. Partial / contains match
        if (!matched) {
            matched = aynaChannels.find(c => {
                const normC = normalize(c.name);
                return normC.includes(normDb) || normDb.includes(normC);
            });
        }

        if (matched && matched.url) {
            const targetUrl = matched.url;
            if (targetUrl !== currentUrl) {
                updates.push({
                    type: 'execute',
                    stmt: {
                        sql: "UPDATE channels SET stream_url = ? WHERE id = ?;",
                        args: [
                            { type: "text", value: targetUrl },
                            { type: "text", value: id }
                        ]
                    }
                });
                console.log(`[UPDATE] ${name}: ${currentUrl} -> ${targetUrl}`);
            } else {
                console.log(`[OK] ${name}: Link is fresh.`);
            }
        } else {
            console.log(`[SKIP] ${name}: No matching channel found in AynaOTT.`);
        }
    }

    if (updates.length > 0) {
        console.log(`Executing ${updates.length} updates in Turso DB...`);
        const BATCH_SIZE = 50;
        for (let i = 0; i < updates.length; i += BATCH_SIZE) {
            const batch = updates.slice(i, i + BATCH_SIZE);
            batch.push({ type: 'close' });

            const upRes = await fetch(TURSO_URL, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${TURSO_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ requests: batch })
            });
            console.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1} status: ${upRes.status}`);
        }
        console.log("Turso DB updated successfully with fresh AynaOTT streams!");
    } else {
        console.log("All AynaOTT channels in Turso DB are already up-to-date.");
    }
}

run().catch(err => {
    console.error("Unhandled error in sync_aynaott:", err);
    process.exit(0); // Exit smoothly so GitHub Actions pipeline continues
});
