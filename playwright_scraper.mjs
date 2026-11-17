import { chromium } from 'playwright';
import fs from 'fs';

async function scrapeToffeeToken() {
  console.log('🚀 Starting Toffee Headless Playwright Harvester...');
  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-A556B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
      viewport: { width: 360, height: 800 },
      isMobile: true,
      hasTouch: true
    });

    const page = await context.newPage();
    let capturedHdntl = null;
    let capturedEdgeToken = null;

    // Intercept all network requests from the live player
    page.on('request', req => {
      const u = req.url();
      if (u.includes('prod-linear-media.toffeelive.com') || u.includes('toffeelive.com')) {
        if (u.includes('hdntl=')) {
          const m = u.match(/hdntl=([^& \r\n"']+)/);
          if (m && m[1] && !capturedHdntl) {
            capturedHdntl = m[1];
            console.log('⚡ Intercepted live hdntl token from player request!');
          }
        }
        if (u.includes('edge-cache-token=')) {
          const m = u.match(/edge-cache-token=([^& \r\n"']+)/);
          if (m && m[1] && !capturedEdgeToken) {
            capturedEdgeToken = m[1];
            console.log('⚡ Intercepted live edge-cache-token from player request!');
          }
        }
      }
    });

    console.log('Navigating to Toffee live channel watch page...');
    await page.goto('https://toffeelive.com/en/watch/wh1VU4B7a1HdMSjaGL7', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // Wait up to 12 seconds for player to initialize and send stream request
    for (let i = 0; i < 12; i++) {
      if (capturedHdntl || capturedEdgeToken) break;
      await page.waitForTimeout(1000);
    }

    if (capturedHdntl || capturedEdgeToken) {
      console.log('✅ Direct harvest successful!');
      const tokenData = {
        hdntl: capturedHdntl,
        edgeCacheToken: capturedEdgeToken,
        updatedAt: new Date().toISOString()
      };
      fs.writeFileSync('toffee_tokens.json', JSON.stringify(tokenData, null, 2));
    } else {
      console.log('Notice: Could not intercept live stream request within timeout. Falling back to Edge CDN escalation & mirrors.');
    }
  } catch (err) {
    console.warn('Playwright harvester note:', err.message);
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }
}

scrapeToffeeToken();
