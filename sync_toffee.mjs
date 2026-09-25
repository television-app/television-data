const TURSO_URL = "https://television-db-nmalifkhan.aws-ap-south-1.turso.io/v2/pipeline";
const TURSO_TOKEN = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODY4MTIwNDMsImlkIjoiMDFhMDA2NGEtMDQwMS03YTU3LTkxZjYtMGU1ZTZlOWMxNjNiIiwia2lkIjoiZHduMVdVSThoakdUUlZYbHI3d0FnR1Z3WnJfaDRVU2xvY3paWERaNmdwbyIsInJpZCI6ImUzYjg3YjQ4LTExNmItNGYyZi1iNzIzLTliZWMzODdhNTZhNSJ9.6ZCMp8BlhqEXnXpTkMoreyxT6oFgVGlEMzPKysiSMBPvPFXwvG87S8UVJe5OEunquitiz_S1xA6cG7UXPyL5Dw";

async function run() {
    console.log("Fetching latest Toffee playlist from srhady/toffee-bd...");
    const res = await fetch('https://raw.githubusercontent.com/srhady/toffee-bd/refs/heads/main/toffee_playlist.json');
    const srhadyData = await res.json();
    
    const srhadyChannels = srhadyData.channels || [];
    console.log(`Fetched ${srhadyChannels.length} channels from srhady.`);

    console.log("Fetching Toffee channels from Turso DB...");
    const dbRes = await fetch(TURSO_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${TURSO_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            requests: [
                { type: 'execute', stmt: { sql: "SELECT id, name, stream_url FROM channels WHERE stream_url LIKE '%toffee%' OR stream_url LIKE '%bldcmprod-cdn%';" } },
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
    console.log(`Found ${rows.length} Toffee channels in DB.`);

    const updates = [];
    const normalize = (str) => str.toLowerCase().replace(/[^a-z0-9]/g, '');

    for (const row of rows) {
        const id = row[0].value;
        const name = row[1].value;
        const currentUrl = row[2].value;

        const normalizedDbName = normalize(name);
        
        let matched = srhadyChannels.find(c => normalize(c.channel_name) === normalizedDbName);
        
        if (!matched) {
            matched = srhadyChannels.find(c => normalize(c.channel_name).includes(normalizedDbName) || normalizedDbName.includes(normalize(c.channel_name)));
        }

        if (matched && matched.stream_url && matched.stream_url !== 'N/A') {
            if (currentUrl !== matched.stream_url) {
                updates.push({
                    type: 'execute',
                    stmt: {
                        sql: "UPDATE channels SET stream_url = ? WHERE id = ?;",
                        args: [
                            { type: "text", value: matched.stream_url },
                            { type: "text", value: id }
                        ]
                    }
                });
                console.log(`[${name}] Matched with ${matched.channel_name}, queueing update...`);
            }
        } else {
            console.log(`[${name}] No active match found in srhady playlist.`);
        }
    }

    if (updates.length > 0) {
        console.log(`Executing ${updates.length} updates in Turso...`);
        
        const BATCH_SIZE = 50;
        for (let i = 0; i < updates.length; i += BATCH_SIZE) {
            const batch = updates.slice(i, i + BATCH_SIZE);
            batch.push({ type: 'close' });
            
            const upRes = await fetch(TURSO_URL, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${TURSO_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ requests: batch })
            });
            console.log(`Updated batch ${Math.floor(i / BATCH_SIZE) + 1}, HTTP: ${upRes.status}`);
        }
        console.log("Sync complete!");
    } else {
        console.log("All channels are already up-to-date. No updates required.");
    }
}

run().catch(console.error);
