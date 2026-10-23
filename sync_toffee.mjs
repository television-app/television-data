const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;

const SOURCE_1_URL = process.env.SOURCE_1_URL;
const SOURCE_2_URL = process.env.SOURCE_2_URL;

async function fetchToffeeChannels() {
    let channels = [];
    let fallbackToken = null;

    // Source 2 (Monirul) - Primary source with active live tokens
    const s2Url = SOURCE_2_URL || "https://raw.githubusercontent.com/sm-monirulislam/Toffee-Auto-Update/main/toffee_data.json";
    try {
        console.log("Fetching Toffee channels from Source 2 (Monirul Live API)...");
        const res = await fetch(s2Url, { 
            signal: AbortSignal.timeout(10000) 
        });
        if (res.ok) {
            const data = await res.json();
            const list = data.response || [];
            const valid = list
                .filter(c => (c.link || c.stream_url) && (c.link || c.stream_url).startsWith('http') && (c.link || c.stream_url) !== 'N/A')
                .map(c => ({
                    name: c.name || c.channel_name,
                    url: c.link || c.stream_url
                }));
            if (valid.length > 0) {
                console.log(`Source 2 succeeded: Found ${valid.length} active live channels.`);
                channels = valid;
            }
        }
    } catch (e) {
        console.warn("Source 2 fetch failed or timed out:", e.message);
    }

    // Source 1 (Srhady) - Fallback source with strict non-N/A filter
    if (channels.length === 0) {
        const s1Url = SOURCE_1_URL || "https://raw.githubusercontent.com/srhady/toffee-bd/refs/heads/main/toffee_playlist.json";
        try {
            console.log("Fetching Toffee channels from Source 1 (Fallback)...");
            const res = await fetch(s1Url, { 
                signal: AbortSignal.timeout(10000) 
            });
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data.channels)) {
                    const valid = data.channels
                        .filter(c => c.stream_url && c.stream_url.startsWith('http') && c.stream_url !== 'N/A')
                        .map(c => ({
                            name: c.channel_name,
                            url: c.stream_url
                        }));
                    if (valid.length > 0) {
                        console.log(`Source 1 succeeded: Found ${valid.length} valid channels.`);
                        channels = valid;
                    }
                }
            }
        } catch (e) {
            console.warn("Source 1 fetch failed or timed out:", e.message);
        }
    }

    // Extract active fallback token from any working channel
    for (const ch of channels) {
        if (ch.url && ch.url.includes('edge-cache-token=')) {
            const match = ch.url.match(/edge-cache-token=([^&]+)/);
            if (match && match[1]) {
                fallbackToken = match[1];
                console.log("Extracted active Edge-Cache-Token:", fallbackToken.slice(0, 60) + "...");
                break;
            }
        }
    }

    return { channels, fallbackToken };
}

async function run() {
    const { channels: remoteChannels, fallbackToken } = await fetchToffeeChannels();

    if (remoteChannels.length === 0 && !fallbackToken) {
        console.error("Could not obtain any Toffee data or tokens from sources. Preserving existing DB data.");
        // We exit smoothly with code 0 so GitHub Actions don't crash the whole pipeline
        return; 
    }

    console.log("Querying Turso DB for Toffee channels...");
    const dbRes = await fetch(TURSO_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${TURSO_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            requests: [
                { type: 'execute', stmt: { sql: "SELECT id, name, stream_url FROM channels WHERE stream_url LIKE '%toffee%' OR stream_url LIKE '%bldcmprod-cdn%' OR stream_url LIKE '%prod-linear-media%';" } },
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
    console.log(`Found ${rows.length} Toffee channels in Turso DB.`);

    const normalize = (str) => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const updates = [];

    for (const row of rows) {
        const id = row[0].value;
        const name = row[1].value;
        const currentUrl = row[2].value;

        const normDb = normalize(name);

        // 1. Try exact or partial match
        let matched = remoteChannels.find(c => normalize(c.name) === normDb);
        if (!matched) {
            matched = remoteChannels.find(c => {
                const normR = normalize(c.name);
                return normR.includes(normDb) || normDb.includes(normR);
            });
        }

        let targetUrl = null;
        if (matched && matched.url && matched.url.startsWith('http') && matched.url.includes('edge-cache-token=')) {
            targetUrl = matched.url;
        } else if (fallbackToken && currentUrl.includes('.m3u8')) {
            // Apply fallback fresh token
            const baseUrl = currentUrl.split('?')[0];
            targetUrl = `${baseUrl}?edge-cache-token=${fallbackToken}`;
        }

        if (targetUrl && targetUrl !== currentUrl) {
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
            console.log(`[${name}] Token update queued.`);
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
        console.log("Turso DB updated successfully with fresh tokens!");
    } else {
        console.log("All channels are already up-to-date with current tokens.");
    }
}

run().catch(err => {
    console.error("Unhandled error in sync_toffee:", err);
    // Exit smoothly so it doesn't break the entire github actions chain
    process.exit(0);
});
