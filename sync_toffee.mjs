const fs = require('fs');

const TURSO_URL = "https://television-db-nmalifkhan.aws-ap-south-1.turso.io/v2/pipeline";
const TURSO_TOKEN = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODY4MTIwNDMsImlkIjoiMDFhMDA2NGEtMDQwMS03YTU3LTkxZjYtMGU1ZTZlOWMxNjNiIiwia2lkIjoiZHduMVdVSThoakdUUlZYbHI3d0FnR1Z3WnJfaDRVU2xvY3paWERaNmdwbyIsInJpZCI6ImUzYjg3YjQ4LTExNmItNGYyZi1iNzIzLTliZWMzODdhNTZhNSJ9.6ZCMp8BlhqEXnXpTkMoreyxT6oFgVGlEMzPKysiSMBPvPFXwvG87S8UVJe5OEunquitiz_S1xA6cG7UXPyL5Dw";

async function run() {
    console.log("Reading toffee_tokens.json...");
    if (!fs.existsSync('toffee_tokens.json')) {
        console.error("toffee_tokens.json not found! Scraper might have failed.");
        return;
    }
    
    const tokenData = JSON.parse(fs.readFileSync('toffee_tokens.json', 'utf8'));
    const newToken = tokenData.cookie; // e.g. "Edge-Cache-Cookie=URLPrefix=aHR0..."
    
    if (!newToken) {
        console.error("No token found in JSON.");
        return;
    }
    
    console.log("New Token loaded successfully.");

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

    for (const row of rows) {
        const id = row[0].value;
        const name = row[1].value;
        const currentUrl = row[2].value;

        // Clean up any existing tokens from the URL
        let baseUrl = currentUrl.split('?')[0];
        
        // Append the new token
        let newUrl = `${baseUrl}?${newToken}`;
        
        // Minor fix for legacy 'edge-cache-token' param format instead of 'Edge-Cache-Cookie'
        // Toffee player usually accepts the exact cookie value as the token param.
        newUrl = newUrl.replace('Edge-Cache-Cookie=', 'edge-cache-token=');

        if (currentUrl !== newUrl) {
            updates.push({
                type: 'execute',
                stmt: {
                    sql: "UPDATE channels SET stream_url = ? WHERE id = ?;",
                    args: [
                        { type: "text", value: newUrl },
                        { type: "text", value: id }
                    ]
                }
            });
            console.log(`[${name}] Token updated in queue.`);
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
        console.log("Sync complete! Turso DB has fresh tokens.");
    } else {
        console.log("All channels already have this token. No updates required.");
    }
}

run().catch(console.error);
