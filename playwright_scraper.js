const { chromium } = require('playwright');
const fs = require('fs');

async function scrapeToffeeTokens() {
  console.log('Starting Toffee Headless Scraper...');
  
  // Launch Playwright Chromium
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  
  const page = await context.newPage();
  
  try {
    // Go to Toffee homepage to get initial cookies
    console.log('Navigating to Toffee website...');
    await page.goto('https://toffeelive.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Wait for basic cookies to settle
    await page.waitForTimeout(5000);
    
    // Go to a live channel page to trigger Edge-Cache-Token generation
    console.log('Navigating to live channel (Somoy TV) to extract Edge Cache Token...');
    await page.goto('https://toffeelive.com/channel/somoy-tv', { waitUntil: 'networkidle', timeout: 60000 });
    
    // Give it time to start video player request
    await page.waitForTimeout(10000);
    
    // Extract Cookies
    const cookies = await context.cookies();
    const edgeCookie = cookies.find(c => c.name.includes('Edge-Cache-Cookie'));
    
    if (edgeCookie) {
      console.log('✅ Edge-Cache-Cookie extracted successfully!');
      
      // Save it to a JSON file for the main sync script to use
      const tokenData = {
        cookie: `${edgeCookie.name}=${edgeCookie.value}`,
        updatedAt: new Date().toISOString()
      };
      
      fs.writeFileSync('toffee_tokens.json', JSON.stringify(tokenData, null, 2));
      console.log('Saved token to toffee_tokens.json');
      
    } else {
      console.log('❌ Failed to extract Edge-Cache-Cookie. Current cookies:');
      console.log(cookies.map(c => c.name).join(', '));
      process.exit(1);
    }
    
  } catch (err) {
    console.error('Error during scraping:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

scrapeToffeeTokens();
