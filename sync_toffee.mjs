import fs from 'fs';

const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;

const SOURCE_1_URL = process.env.SOURCE_1_URL;
const SOURCE_2_URL = process.env.SOURCE_2_URL;

async function fetchToffeeChannels() {
    let channels = [];
    let fallbackToken = null;
    let directHdntl = null;

    // 0. Check for Direct Harvested Tokens from Playwright
    if (fs.existsSync('toffee_tokens.json')) {
        try {
            const raw = fs.readFileSync('toffee_tokens.json', 'utf8');
            const harvested = JSON.parse(raw);
            if (harvested.hdntl) {
                directHdntl = harvested.hdntl;
                console.log("Found direct Playwright HDNTL token:", directHdntl.slice(0, 50) + "...");
            }
            if (harvested.edgeCacheToken) {
                fallbackToken = harvested.edgeCacheToken;
                console.log("Found direct Playwright Edge token:", fallbackToken.slice(0, 50) + "...");
            }
        } catch (e) {
            console.warn("Could not read toffee_tokens.json:", e.message);
        }
    }

    // 1. Source 2 (Monirul) - Live API mirror
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

    // 2. Source 1 (Srhady) - Fallback source with strict non-N/A filter
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

    // 3. Extract active fallback token from any working channel if not already obtained
    if (!fallbackToken) {
        for (const ch of channels) {
            if (ch.url && ch.url.includes('edge-cache-token=')) {
                const match = ch.url.match(/edge-cache-token=([^&]+)/);
                if (match && match[1]) {
                    fallbackToken = match[1];
                    console.log("Extracted active Edge-Cache-Token from channels:", fallbackToken.slice(0, 60) + "...");
                    break;
                }
            }
        }
    }

    // 4. Ultra-Smart Escalation: Fetch 24-Hour HDNTL Token from Toffee Edge CDN
    let hdntlToken = directHdntl;
    if (!hdntlToken && fallbackToken) {
        try {
            console.log("⚡ Escalating to 24-Hour HDNTL Token via Toffee Edge CDN...");
            const escRes = await fetch(`https://prod-linear-media.toffeelive.com/cdn/live/somoy_tv/playlist.m3u8?edge-cache-token=${fallbackToken}`, {
                headers: { 
                    'User-Agent': 'Toffee (Linux;Android 14) AndroidXMedia3/1.1.1/64103898/4d2ec9b8c7534adc',
                    'Origin': 'https://toffeelive.com',
                    'Referer': 'https://toffeelive.com/'
                },
                signal: AbortSignal.timeout(8000)
            });
            if (escRes.ok) {
                const playlistText = await escRes.text();
                const hMatch = playlistText.match(/hdntl=([^ \r\n"']+)/);
                if (hMatch && hMatch[1]) {
                    hdntlToken = hMatch[1];
                    console.log("✅ Successfully escalated to 24-Hour HDNTL Token:", hdntlToken.slice(0, 60) + "...");
                }
            }
        } catch (e) {
            console.warn("HDNTL escalation notice:", e.message);
        }
    }

    return { channels, fallbackToken, hdntlToken };
}

async function run() {
    const { channels: remoteChannels, fallbackToken, hdntlToken } = await fetchToffeeChannels();

    if (remoteChannels.length === 0 && !fallbackToken && !hdntlToken) {
        console.error("Could not obtain any Toffee data or tokens from sources. Preserving existing DB data.");
        return; 
    }

    console.log("Querying Turso DB for Toffee channels...");
    const dbRes = await fetch(TURSO_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${TURSO_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            requests: [
                { type: 'execute', stmt: { sql: "SELECT id, name, stream_url, backup_urls FROM channels WHERE stream_url LIKE '%toffee%' OR stream_url LIKE '%bldcmprod-cdn%' OR stream_url LIKE '%prod-linear-media%' OR backup_urls LIKE '%toffee%' OR backup_urls LIKE '%bldcmprod-cdn%' OR backup_urls LIKE '%prod-linear-media%';" } },
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
        const currentUrl = row[2] ? row[2].value : '';
        const currentBackups = row[3] ? row[3].value : '';

        let targetUrl = currentUrl;
        let targetBackups = currentBackups;
        let modified = false;

        const normDb = normalize(name);

        // 1. Try exact or partial match from fresh remote channel list
        let matched = remoteChannels.find(c => normalize(c.name) === normDb);
        if (!matched) {
            matched = remoteChannels.find(c => {
                const normR = normalize(c.name);
                return normR.includes(normDb) || normDb.includes(normR);
            });
        }

        // Normalize legacy domain
        let basePrimary = (currentUrl || '').replace('bldcmprod-cdn.toffeelive.com', 'prod-linear-media.toffeelive.com');
        let primaryWithoutQuery = basePrimary.split('?')[0];
        const isMaster = primaryWithoutQuery.endsWith('playlist.m3u8');

        if (matched && matched.url && matched.url.startsWith('http')) {
            targetUrl = matched.url.replace('bldcmprod-cdn.toffeelive.com', 'prod-linear-media.toffeelive.com');
        } else if (primaryWithoutQuery.includes('.m3u8')) {
            if (isMaster && fallbackToken) {
                targetUrl = `${primaryWithoutQuery}?edge-cache-token=${fallbackToken}`;
            } else if (!isMaster && (hdntlToken || fallbackToken)) {
                const tok = hdntlToken || fallbackToken;
                const param = hdntlToken ? 'hdntl' : 'edge-cache-token';
                targetUrl = `${primaryWithoutQuery}?${param}=${tok}`;
            }
        }

        if (targetUrl !== currentUrl) {
            modified = true;
        }

        // Process backup URLs if any
        if (currentBackups && (currentBackups.includes('toffee') || currentBackups.includes('prod-linear-media') || currentBackups.includes('bldcmprod-cdn'))) {
            const bList = currentBackups.split(',').map(u => u.trim()).filter(Boolean);
            const newBList = [];
            let bMod = false;

            for (const bUrl of bList) {
                let cleanB = bUrl.replace('bldcmprod-cdn.toffeelive.com', 'prod-linear-media.toffeelive.com');
                let bWithoutQuery = cleanB.split('?')[0];
                let bIsMaster = bWithoutQuery.endsWith('playlist.m3u8');
                let newB = cleanB;

                if (bIsMaster && fallbackToken) {
                    newB = `${bWithoutQuery}?edge-cache-token=${fallbackToken}`;
                } else if (!bIsMaster && (hdntlToken || fallbackToken)) {
                    const tok = hdntlToken || fallbackToken;
                    const param = hdntlToken ? 'hdntl' : 'edge-cache-token';
                    newB = `${bWithoutQuery}?${param}=${tok}`;
                }

                if (newB !== bUrl) bMod = true;
                newBList.push(newB);
            }

            if (bMod) {
                targetBackups = newBList.join(',');
                modified = true;
            }
        }

        if (modified) {
            updates.push({
                type: 'execute',
                stmt: {
                    sql: "UPDATE channels SET stream_url = ?, backup_urls = ? WHERE id = ?;",
                    args: [
                        { type: "text", value: targetUrl },
                        { type: "text", value: targetBackups },
                        { type: "text", value: String(id) }
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
    process.exit(0);
});
