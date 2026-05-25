const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const dns = require('dns').promises;
const { google } = require('googleapis');
const { Readable } = require('stream');
const URL = require('url').URL;

const app = express();
app.use(express.json());


async function dnsresolve(domain) {
    const resolver = new dns.Resolver();
    resolver.setServers(['1.1.1.1', '1.0.0.1']);
    const result=await resolver.resolve4(domain);
    return result
}

// --- CONFIGURATION ---
const REQUEST_TIMEOUT = 20000;
const MAX_INTERNAL_PAGES = 10; // Slightly higher, but rarely hit due to strict filtering
const ALLOWED_TLDS = ['com', 'net', 'io', 'co', 'biz', 'me', 'app'];
const PARENT_FOLDER_NAME = 'Sites Auth Forms';

// Keywords that indicate a page might contain an auth form
const AUTH_URL_REGEX = /login|signin|sign-in|register|signup|sign-up|join|account|auth|portal/i;

// --- STATE MANAGEMENT ---
const visitedDomains = new Set();
const globalQueue = [];
let isProcessingQueue = false;
let driveFolderCache = {}; 

// --- DRIVE API HELPERS ---
async function getOrCreateFolder(drive, folderName, parentId = null) {
    const cacheKey = parentId ? `${parentId}_${folderName}` : folderName;
    if (driveFolderCache[cacheKey]) return driveFolderCache[cacheKey];

    let query = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`;
    if (parentId) query += ` and '${parentId}' in parents`;

    const response = await drive.files.list({ q: query, fields: 'files(id, name)' });

    if (response.data.files.length > 0) {
        const folderId = response.data.files[0].id;
        driveFolderCache[cacheKey] = folderId;
        return folderId;
    }

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
        const parentFolderId = await getOrCreateFolder(drive, PARENT_FOLDER_NAME);
        const categoryFolderId = await getOrCreateFolder(drive, category, parentFolderId);

        const fileMetadata = { name: `${siteName}.json`, parents: [categoryFolderId] };
        const media = {
            mimeType: 'application/json',
            body: Readable.from([JSON.stringify(jsonData, null, 2)])
        };

        await drive.files.create({ resource: fileMetadata, media: media, fields: 'id' });
        console.log(`[Drive] Uploaded ${siteName}.json to '${category}'`);
    } catch (error) {
        console.error(`[Drive] Failed to upload ${siteName}:`, error.message);
    }
}

// --- UTILS & FORM CLASSIFICATION ---
function getRootDomain(hostname) {
    const parts = hostname.replace('www.', '').split('.');
    return parts.length >= 2 ? parts.slice(-2).join('.') : hostname;
}

function classifySite(report) {
    const hasLogin = report.loginForms.length > 0;
    const hasRegister = report.registerForms.length > 0;
    
    if (hasLogin && hasRegister) return 'both';
    if (hasLogin) return 'login';
    if (hasRegister) return 'register';
    return 'none';
}

function isAuthForm($, form) {
    const action = ($(form).attr('action') || '').toLowerCase();
    const hasPassword = $(form).find('input[type="password"]').length > 0;
    const hasAuthKeywords = /login|signin|register|signup|auth/i.test(action);
    return hasPassword || hasAuthKeywords;
}

function categorizeForm($, form) {
    const action = ($(form).attr('action') || '').toLowerCase();
    const text = $(form).text().toLowerCase();
    if (/register|signup|sign-up|create account/i.test(`${text} ${action}`)) return 'registerForms';
    return 'loginForms';
}

// --- CORE CRAWLER LOGIC ---
async function targetedAuthCrawl(baseUrl) {
    const rootDomain = getRootDomain(new URL(baseUrl).hostname);
    const internalQueue = [baseUrl]; // Always start with homepage
    const visitedInternal = new Set();
    
    const siteReport = {
        domain: rootDomain,
        category: 'none',
        pagesCrawled: 0,
        loginForms: [],
        registerForms: [],
        outboundDomains: new Set()
    };

    while (internalQueue.length > 0 && siteReport.pagesCrawled < MAX_INTERNAL_PAGES) {
        const currentUrl = internalQueue.shift();
        if (visitedInternal.has(currentUrl)) continue;
        visitedInternal.add(currentUrl);

        try {
            console.log(`  -> [Targeted] Scraping: ${currentUrl}`);
            const response = await axios.get(currentUrl, { 
                timeout: REQUEST_TIMEOUT,
                headers: { 'User-Agent': 'GoogleBot' }
            });
            const $ = cheerio.load(response.data);
            siteReport.pagesCrawled++;

            // Extract Auth Forms
            $('form').each((_, form) => {
                if (isAuthForm($, form)) {
                    const formDetails = {
                        url: currentUrl,
                        action: $(form).attr('action') || null,
                        method: ($(form).attr('method') || 'GET').toUpperCase(),
                        inputs: []
                    };

                    $(form).find('input, select').each((_, input) => {
                        formDetails.inputs.push({
                            type: $(input).attr('type') || null,
                            name: $(input).attr('name') || 'unnamed'
                        });
                    });

                    const type = categorizeForm($, form);
                    siteReport[type].push(formDetails);
                }
            });

            // Extract Links
            $('a').each((_, el) => {
                const href = $(el).attr('href');
                if (!href || href.startsWith('javascript:')) return;

                try {
                    const parsedUrl = new URL(href, baseUrl);
                    const hrefRoot = getRootDomain(parsedUrl.hostname);

                    if (hrefRoot === rootDomain) {
                        // SMART FILTER: Only queue internal links if they look like Auth/Account pages
                        if (AUTH_URL_REGEX.test(parsedUrl.pathname) && !visitedInternal.has(parsedUrl.href)) {
                            internalQueue.push(parsedUrl.href);
                        }
                    } else {
                        // Keep track of external domains to feed the master queue
                        const tld = hrefRoot.split('.').pop().toLowerCase();
                        if (ALLOWED_TLDS.includes(tld)) {
                            siteReport.outboundDomains.add(hrefRoot);
                        }
                    }
                } catch (e) {}
            });

        } catch (error) {
            // Ignore 404s, timeouts, etc.
        }
    }

    siteReport.category = classifySite(siteReport);
    const nextTargets = Array.from(siteReport.outboundDomains);
    siteReport.outboundDomains = nextTargets;

    return { siteReport, nextTargets };
}

// --- QUEUE PROCESSOR & PARALLEL DNS ---
async function processQueue(accessToken) {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (globalQueue.length > 0) {
        const nextUrl = globalQueue.shift();
        const rootDomain = getRootDomain(new URL(nextUrl).hostname);

        if (visitedDomains.has(rootDomain)) continue;
        visitedDomains.add(rootDomain);

        console.log(`\n[Queue] Starting site: ${rootDomain} | Remaining: ${globalQueue.length}`);

        try {
            const { siteReport, nextTargets } = await targetedAuthCrawl(nextUrl);
            
            // Upload to Google Drive
            await uploadToDrive(accessToken, rootDomain, siteReport.category, siteReport);
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
    console.log('[Queue] Empty. Waiting for new URLs.');
}

// --- EXPRESS ENDPOINT ---
app.post('/api/start-crawler', (req, res) => {
    const { startUrls, accessToken } = req.body;

    if (!Array.isArray(startUrls) || !accessToken) {
        return res.status(400).json({ error: 'Requires startUrls array and accessToken.' });
    }

    startUrls.forEach(url => globalQueue.push(url));
    processQueue(accessToken).catch(console.error);

    res.status(202).json({ 
        message: 'Auth Form Crawler running.',
        queueSize: globalQueue.length 
    });
});

app.listen(3000, () => console.log('Auth Crawler running on http://localhost:3000'));
