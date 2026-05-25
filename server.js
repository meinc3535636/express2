const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const dns = require('dns').promises;
const { google } = require('googleapis');
const { Readable } = require('stream');
const URL = require('url').URL;

const DOMAIN_REGEX = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(com|io|co|ai|app|dev|computer|nl|de|eu|me)\b/gi;
const app = express();
app.use(express.json());

async function dnsresolve(domain) {
    const resolver = new dns.Resolver();
    resolver.setServers(['1.1.1.1', '1.0.0.1']);
    const result=await resolver.resolve4(domain);
    return result
}

// --- CONFIGURATION ---
const MAX_INTERNAL_PAGES = 4;
const REQUEST_TIMEOUT = 20000;
const ALLOWED_TLDS = ['net','in','ru','blog','gov','org'];
const PARENT_FOLDER_NAME = 'sites list';

// --- STATE MANAGEMENT ---
const visitedDomains = new Set();
const globalQueue = [];
let isProcessingQueue = false;
let driveFolderCache = {}; // Caches folder IDs: { 'sites list': 'ID', 'saas': 'ID', ... }

// --- DRIVE API HELPERS ---
async function getOrCreateFolder(drive, folderName, parentId = null) {
    // Return from cache if we already found/created it
    const cacheKey = parentId ? `${parentId}_${folderName}` : folderName;
    if (driveFolderCache[cacheKey]) return driveFolderCache[cacheKey];

    // Check if folder exists
    let query = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`;
    if (parentId) query += ` and '${parentId}' in parents`;

    const response = await drive.files.list({ q: query, fields: 'files(id, name)' });

    if (response.data.files.length > 0) {
        const folderId = response.data.files[0].id;
        driveFolderCache[cacheKey] = folderId;
        return folderId;
    }

    // Create if it doesn't exist
    const fileMetadata = {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : undefined
    };

    const createResponse = await drive.files.create({ resource: fileMetadata, fields: 'id' });
    const newFolderId = createResponse.data.id;
    driveFolderCache[cacheKey] = newFolderId;
    return newFolderId;
}

async function uploadToDrive(accessToken, siteName, category, jsonData) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    const drive = google.drive({ version: 'v3', auth });

    try {
        // 1. Get/Create "sites list" parent folder
        const parentFolderId = await getOrCreateFolder(drive, PARENT_FOLDER_NAME);
        
        // 2. Get/Create category sub-folder inside "sites list"
        const categoryFolderId = await getOrCreateFolder(drive, category, parentFolderId);

        // 3. Upload JSON
        const fileMetadata = {
            name: `${siteName}.json`,
            parents: [categoryFolderId]
        };
        const media = {
            mimeType: 'application/json',
            body: Readable.from([JSON.stringify(jsonData, null, 2)])
        };

        await drive.files.create({ resource: fileMetadata, media: media, fields: 'id' });
        console.log(`[Drive] Uploaded ${siteName}.json to '${PARENT_FOLDER_NAME}/${category}'`);
    } catch (error) {
        console.error(`[Drive] Failed to upload ${siteName}:`, error.message);
    }
}

// --- UTILS ---
function getRootDomain(hostname) {
    const parts = hostname.replace('www.', '').split('.');
    return parts.length >= 2 ? parts.slice(-2).join('.') : hostname;
}

function categorizeSite(text) {
    const t = text.toLowerCase();
    const scores = { saas: 0, social: 0, ecommerce: 0 };
    const keywords = {
        saas: ['pricing', 'signup', 'dashboard', 'subscription', 'api']
    };

    for (const [category, words] of Object.entries(keywords)) {
        for (const word of words) {
            const matches = t.match(new RegExp(`\\b${word}\\b`, 'g'));
            if (matches) scores[category] += matches.length;
        }
    }

    let bestCategory = 'general';
    let highest = 2; // threshold
    for (const [cat, score] of Object.entries(scores)) {
        if (score > highest) { highest = score; bestCategory = cat; }
    }
    return bestCategory;
}

// --- CORE CRAWLER LOGIC ---
async function deepCrawlDomain(baseUrl) {
    const rootDomain = getRootDomain(new URL(baseUrl).hostname);
    const internalQueue = [baseUrl];
    const visitedInternal = new Set();
    
    const siteReport = {
        domain: rootDomain,
        category: 'general',
        description: '',
        pagesCrawled: 0,
        outboundDomains: new Set(),
        internalLinks: new Set(),
        forms: [],
        pages: [],
        aggregateText: ""
    };

    while (internalQueue.length > 0 && siteReport.pagesCrawled < MAX_INTERNAL_PAGES) {
        const currentUrl = internalQueue.shift();
        if (visitedInternal.has(currentUrl)) continue;
        visitedInternal.add(currentUrl);

        try {
            console.log(`  -> Scraping: ${currentUrl}`);
            const response = await axios.get(currentUrl, { timeout: REQUEST_TIMEOUT,
                 headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
                    }, });
            const html = response.data;
            const matches = html.match(DOMAIN_REGEX) || [];
            siteReport.outboundDomains = siteReport.outboundDomains.union( new Set(matches.map(d => d.toLowerCase())) );
            const $ = cheerio.load(html);
            const textContent = $('body').text().replace(/\s+/g, ' ');

            // Set main description if this is the homepage
            if (siteReport.pagesCrawled === 0) {
                siteReport.description = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
            }

            // Extract Forms
            $('form').each((_, el) => {
                const action = $(el).attr('action') || 'unknown';
                const method = $(el).attr('method') || 'GET';
                const inputs = [];
                
                $(el).find('input, select, textarea').each((_, input) => {
                    inputs.push({
                        type: $(input).attr('type') || el.tagName.toLowerCase(),
                        name: $(input).attr('name') || 'unnamed'
                    });
                });

                siteReport.forms.push({ page: currentUrl, action, method, inputs });
            });
            
            // Extract Links
            $('a').each((_, el) => {
                const href = $(el).attr('href');
                if (!href || href.startsWith('javascript:') || href.startsWith('mailto:')) return;

                // Avoid blogs and news
                if (href.toLowerCase().includes('blog') || href.toLowerCase().includes('news') || href.toLowerCase().includes('article')) return;

                try {
                    const parsedHref = new URL(href, baseUrl);
                    const hrefRoot = getRootDomain(parsedHref.hostname);

                    if (hrefRoot === rootDomain) {
                        siteReport.internalLinks.add(parsedHref.href);
                        if (!visitedInternal.has(parsedHref.href)) internalQueue.push(parsedHref.href);
                    } else {
                        const tld = hrefRoot.split('.').pop().toLowerCase();
                        if (!ALLOWED_TLDS.includes(tld)) siteReport.outboundDomains.add(hrefRoot);
                    }
                } catch (e) {} // ignore malformed urls
            });

            siteReport.pages.push({
                url: currentUrl,
                title: $('title').text().trim()
            });
            siteReport.aggregateText += textContent + " ";
            siteReport.pagesCrawled++;

        } catch (error) {
            siteReport.error=true;
            return { siteReport, nextTargets:[] }
            console.error(`  -> [Error] Failed on ${currentUrl}:`, error.message);
        }
    }

    siteReport.category = categorizeSite(siteReport.aggregateText);
    delete siteReport.aggregateText; 
    
    const nextTargets = Array.from(siteReport.outboundDomains);
    siteReport.outboundDomains = nextTargets;
    siteReport.internalLinks = Array.from(siteReport.internalLinks);

    return { siteReport, nextTargets };
}

// --- QUEUE PROCESSOR (One at a time) ---
async function processQueue(accessToken) {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (globalQueue.length > 0) {
        const nextUrl = globalQueue.shift();
        const rootDomain = getRootDomain(new URL(nextUrl).hostname);

        if (visitedDomains.has(rootDomain)) continue;
        visitedDomains.add(rootDomain);

        console.log(`\n[Processing Queue] Starting site: ${rootDomain}`);
        console.log(`[Queue Status] Remaining sites: ${globalQueue.length}`);

        try {
            const { siteReport, nextTargets } = await deepCrawlDomain(nextUrl);
            await uploadToDrive(accessToken, rootDomain, siteReport.category, siteReport);

            // Verify DNS and add outbound domains to queue
            for (const domain of nextTargets) {
                if (!visitedDomains.has(domain)) {
                    try {
                        await dnsresolve(domain);
                        globalQueue.push(`http://${domain}`);
                    } catch (e) { /* DNS Failed, ignore */ }
                }
            }
        } catch (error) {
            console.error(`[Queue Error] on ${nextUrl}:`, error.message);
        }
    }

    isProcessingQueue = false;
    console.log('[Queue] All done! Waiting for new URLs.');
}

// --- EXPRESS ENDPOINT ---
app.post('/api/start-crawler', (req, res) => {
    const { startUrls, accessToken } = req.body;

    if (!Array.isArray(startUrls) || !accessToken) {
        return res.status(400).json({ error: 'Requires startUrls array and accessToken.' });
    }

    startUrls.forEach(url => globalQueue.push(url));
    
    // Start processing asynchronously in the background
    processQueue(accessToken).catch(console.error);

    res.status(202).json({ 
        message: 'URLs added to global queue. Crawler is running sequentially.',
        queueSize: globalQueue.length 
    });
});

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.listen(3000, () => console.log('Server running on http://localhost:3000'));

