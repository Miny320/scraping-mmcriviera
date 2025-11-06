const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../config.json');

const CONFIG = {
    API_URL: 'https://www.mmcriviera.com/bbcontent/plugin/bbmmc/',
    PARENT_URL: config.PARENT_URL,
    CHECK_INTERVAL: config.CHECK_INTERVAL,
    BACK_END_URL: config.BACK_END_URL,
};

const wait = (ms) => new Promise(r => setTimeout(r, ms));

const fetchPage = async (page = 1, retries = 3) => {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const response = await axios.post(
                CONFIG.API_URL,
                `default=361&currentObjectID=361&classid=39&page=${page}`,
                {
                    headers: {
                        'Accept': 'text/html, */*; q=0.01',
                        'Accept-Encoding': 'gzip, deflate, br, zstd',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Connection': 'keep-alive',
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'Origin': 'https://www.mmcriviera.com',
                        'Referer': 'https://www.mmcriviera.com/en',
                        'Sec-CH-UA': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
                        'Sec-CH-UA-Mobile': '?0',
                        'Sec-CH-UA-Platform': '"Windows"',
                        'Sec-Fetch-Dest': 'empty',
                        'Sec-Fetch-Mode': 'cors',
                        'Sec-Fetch-Site': 'same-origin',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    timeout: 30000
                }
            );
            return response.data;
        } catch (error) {
            const isRateLimit = error.response?.status === 429;
            const isServerError = error.response?.status >= 500;
            const isConnectionError = error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.message.includes('timeout');
            
            // If rate limited, wait longer before retry
            if (isRateLimit && attempt < retries - 1) {
                const backoffTime = Math.min(5000 * Math.pow(2, attempt), 30000); // Max 30 seconds
                await wait(backoffTime);
                continue;
            }
            
            // If server error or connection error, retry with exponential backoff
            if ((isServerError || isConnectionError) && attempt < retries - 1) {
                const backoffTime = Math.min(1000 * Math.pow(2, attempt), 10000); // Max 10 seconds
                await wait(backoffTime);
                continue;
            }
            
            // Last attempt failed or non-retryable error
            if (attempt === retries - 1) {
                console.error(`Error fetching page ${page} after ${retries} attempts:`, error.message);
                return null;
            }
        }
    }
    return null;
};

const hasProductsOnPage = (html) => {
    const $ = cheerio.load(html);
    // Check if there are any .watch-thumbnail elements at all (sold or not)
    return $('.watch-thumbnail').length > 0;
};

const extractProductUrls = (html, includeSold = false) => {
    const $ = cheerio.load(html);
    const urls = [];
    const soldUrls = [];
    
    $('.watch-thumbnail').each((index, element) => {
        const $card = $(element);
        
        // Extract product URL
        const $link = $card.find('a.result-item');
        if ($link.length > 0) {
            const href = $link.attr('href');
            if (href) {
                // Make sure URL is absolute
                const absoluteUrl = href.startsWith('http') 
                    ? href 
                    : `https://www.mmcriviera.com${href}`;
                
                // Check if product is sold - multiple ways to detect
                const hasSoldClass = $card.find('.detail-sold').length > 0;
                const priceText = $card.find('.result-price').text().trim().toLowerCase();
                const isSold = hasSoldClass || priceText === 'sold';
                
                if (isSold) {
                    soldUrls.push(absoluteUrl);
                    if (!includeSold) {
                        return; // Skip sold products
                    }
                }
                
                urls.push(absoluteUrl);
            }
        }
    });
    
    return { urls, soldUrls };
};

const processPageResult = (html, pageNum) => {
    if (!html) {
        return { page: pageNum, hasProducts: false, isEmpty: true, error: true };
    }
    
    const hasProducts = hasProductsOnPage(html);
    
    if (!hasProducts) {
        return { page: pageNum, hasProducts: false, isEmpty: true, error: false };
    }
    
    const $ = cheerio.load(html);
    const totalProducts = $('.watch-thumbnail').length;
    const { urls, soldUrls } = extractProductUrls(html, false);
    const { urls: allUrlsOnPage } = extractProductUrls(html, true);
    
    return {
        page: pageNum,
        hasProducts: true,
        isEmpty: false,
        error: false,
        totalProducts,
        availableUrls: urls,
        soldUrls: soldUrls,
        allUrls: allUrlsOnPage
    };
};

const getAllProductUrls = async () => {
    const availableUrlsList = [];
    const BATCH_SIZE = 20; // Reduced from 50 to avoid rate limiting
    const MAX_CONSECUTIVE_EMPTY = 3; // Stop after 3 consecutive pages with no products
    const DELAY_BETWEEN_REQUESTS = 100; // Small delay between requests in batch
    
    let currentPage = 1;
    let consecutiveEmptyPages = 0;
    let hasMorePages = true;
    
    console.log(`Starting to fetch product URLs with concurrent batches of ${BATCH_SIZE}...`);
    
    while (hasMorePages) {
        // Create batch of pages
        const batchPages = [];
        for (let i = 0; i < BATCH_SIZE; i++) {
            batchPages.push(currentPage + i);
        }
        
        console.log(`Fetching pages ${batchPages[0]} to ${batchPages[batchPages.length - 1]} (${BATCH_SIZE} concurrent requests)...`);
        
        // Fetch all pages in batch concurrently with small delays to avoid overwhelming server
        const batchPromises = batchPages.map((pageNum, index) => 
            wait(index * DELAY_BETWEEN_REQUESTS).then(() => 
                fetchPage(pageNum).then(html => ({ pageNum, html }))
            )
        );
        
        const batchResults = await Promise.allSettled(batchPromises);
        
        // Process results
        let foundAnyAvailableProducts = false;
        let emptyPagesInBatch = 0;
        let allSoldPagesInBatch = 0;
        
        for (let i = 0; i < batchResults.length; i++) {
            const result = batchResults[i];
            const pageNum = batchPages[i];
            
            if (result.status === 'fulfilled') {
                const pageData = processPageResult(result.value.html, pageNum);
                
                if (pageData.hasProducts) {
                    // Check if all products are sold
                    if (pageData.availableUrls && pageData.availableUrls.length === 0) {
                        // All products on this page are sold
                        allSoldPagesInBatch++;
                        console.log(`Page ${pageNum}: All ${pageData.totalProducts} products are SOLD`);
                    } else {
                        // Found available products
                        foundAnyAvailableProducts = true;
                        consecutiveEmptyPages = 0; // Reset counter when we find available products
                        
                        // Extract URLs
                        if (pageData.availableUrls) {
                            availableUrlsList.push(...pageData.availableUrls);
                        }
                        
                        console.log(`Page ${pageNum}: Found ${pageData.availableUrls.length} available products (${pageData.soldUrls.length} sold, ${pageData.totalProducts} total)`);
                    }
                } else if (!pageData.error) {
                    // Empty page (no products)
                    emptyPagesInBatch++;
                }
            } else {
                // Request failed
                console.error(`Page ${pageNum}: Request failed - ${result.reason?.message || 'Unknown error'}`);
                emptyPagesInBatch++;
            }
        }
        
        // Check if we should continue
        if (!foundAnyAvailableProducts) {
            // No available products found in this batch
            if (allSoldPagesInBatch > 0) {
                // All products in this batch are sold - stop immediately
                console.log(`Batch ${batchPages[0]}-${batchPages[batchPages.length - 1]}: All products are SOLD. Stopping.`);
                hasMorePages = false;
            } else if (emptyPagesInBatch > 0) {
                // All pages in this batch were empty
                consecutiveEmptyPages += emptyPagesInBatch;
                console.log(`Batch ${batchPages[0]}-${batchPages[batchPages.length - 1]}: No products found in any page (consecutive empty: ${consecutiveEmptyPages})`);
                
                if (consecutiveEmptyPages >= MAX_CONSECUTIVE_EMPTY) {
                    console.log(`Stopping after ${consecutiveEmptyPages} consecutive empty pages.`);
                    hasMorePages = false;
                }
            }
        } else {
            consecutiveEmptyPages = 0; // Reset if we found any available products
        }
        
        currentPage += BATCH_SIZE;
        
        // Longer delay between batches to avoid rate limiting
        if (hasMorePages) {
            await wait(2000); // Increased from 500ms to 2 seconds
        }
    }
    
    // Remove duplicates
    const uniqueUrls = [...new Set(availableUrlsList)];
    
    console.log(`\n=== Summary ===`);
    console.log(`Total unique available product URLs: ${uniqueUrls.length}`);
    console.log(`Total pages processed: ${currentPage - BATCH_SIZE}`);
    
    return { availableUrls: uniqueUrls };
};

const fetchProductPage = async (watchUrl, retries = 3) => {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const response = await axios.get(watchUrl, {
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                    'Accept-Encoding': 'gzip, deflate, br, zstd',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Connection': 'keep-alive',
                    'Sec-CH-UA': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
                    'Sec-CH-UA-Mobile': '?0',
                    'Sec-CH-UA-Platform': '"Windows"',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Sec-Fetch-User': '?1',
                    'Upgrade-Insecure-Requests': '1',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
                },
                timeout: 30000
            });
            return response.data;
        } catch (error) {
            const isRateLimit = error.response?.status === 429;
            const isServerError = error.response?.status >= 500;
            const isConnectionError = error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.message.includes('timeout');
            
            if (isRateLimit && attempt < retries - 1) {
                const backoffTime = Math.min(5000 * Math.pow(2, attempt), 30000);
                await wait(backoffTime);
                continue;
            }
            
            if ((isServerError || isConnectionError) && attempt < retries - 1) {
                const backoffTime = Math.min(1000 * Math.pow(2, attempt), 10000);
                await wait(backoffTime);
                continue;
            }
            
            if (attempt === retries - 1) {
                console.error(`Error fetching product page ${watchUrl} after ${retries} attempts:`, error.message);
                return null;
            }
        }
    }
    return null;
};

const extractWatchDetails = (html, watchUrl) => {
    const $ = cheerio.load(html);
    const details = {
        brand: '',
        model: '',
        referenceNumber: '',
        year: null,
        price: 0,
        currency: 'EUR',
        originalBox: false,
        originalPaper: false,
        condition: 'worn',
        location: 'Monaco, MC98000',
        images: [],
        watchUrl: watchUrl
    };

    // Extract brand and model from title
    const detailTitle = $('.detail-title').first();
    const titleBrand = detailTitle.find('strong').first();
    const titleItalic = detailTitle.find('i').first();
    
    if (titleBrand.length) {
        details.brand = titleBrand.text().trim();
    }
    
    // Model is the text between </strong> and <i> tags
    if (detailTitle.length) {
        // Clone the element to avoid modifying the original
        const clone = detailTitle.clone();
        // Remove strong and i tags, leaving only the model text
        clone.find('strong').remove();
        clone.find('i').remove();
        const modelText = clone.text().trim().replace(/\s+/g, ' ');
        if (modelText) {
            details.model = modelText;
        }
    }

    // Extract reference from italic text (most reliable)
    const extractRef = (text) => {
        if (!text) return '';
        const tokens = text.split(/\s+/).map(t => t.replace(/[,.;:()]/g, ''));
        for (const t of tokens) {
            if (/^[A-Za-z0-9\/-]{3,}$/.test(t) && /\d/.test(t)) return t;
        }
        const m = text.match(/([A-Za-z0-9\/-]{3,}\d[A-Za-z0-9\/-]*)/);
        return m ? m[1] : '';
    };

    if (!details.referenceNumber && titleItalic.length) {
        const refFromItalic = extractRef(titleItalic.text());
        if (refFromItalic) details.referenceNumber = refFromItalic;
    }

    // Fallback: extract from breadcrumb
    if (!details.referenceNumber) {
        const breadcrumb = $('.detail-breadcrumb').first();
        if (breadcrumb.length) {
            const bcText = breadcrumb.text().replace(/\s+/g, ' ').trim();
            const refFromBc = extractRef(bcText);
            if (refFromBc) details.referenceNumber = refFromBc;
        }
    }

    // Extract details from detail lines
    $('.detail-datas .detail-line').each((index, element) => {
        const $line = $(element);
        const labelEl = $line.find('.detail-label');
        const valueEl = $line.find('.detail-data');
        if (!labelEl.length || !valueEl.length) return;
        
        const label = labelEl.text().trim().toLowerCase();
        const value = valueEl.text().replace(/\s+/g, ' ').trim();

        if (label === 'price') {
            if (value.includes('€')) details.currency = 'EUR';
            else if (value.includes('$')) details.currency = 'USD';
            const m = value.replace(/\./g, '').match(/([0-9][0-9.,]+)/);
            if (m) details.price = parseInt(m[1].replace(/[,\.]/g, '')) || 0;
        }
        if (label === 'year') {
            const y = parseInt(value.replace(/[^0-9]/g, ''));
            if (!isNaN(y)) details.year = y;
        }
        if (label === 'condition') {
            const v = value.toLowerCase();
            if (v.includes('mint') || v.includes('unworn') || v.includes('new')) details.condition = 'unworn';
            else details.condition = 'worn';
        }
        if (label === 'new/unworn') {
            const v = value.toLowerCase();
            if (v.includes('new')) details.condition = 'unworn';
            if (v.includes('pre-owned')) details.condition = 'worn';
        }
        if (label === 'scope of delivery') {
            const v = value.toLowerCase();
            details.originalBox = v.includes('box');
            details.originalPaper = v.includes('paper') || v.includes('papers') || v.includes('certificate') || v.includes('card');
        }
        if (label === 'certified') {
            const v = value.toLowerCase();
            if (v.includes('yes')) details.originalPaper = details.originalPaper || false;
        }
    });

    // Extract images
    $('.watch-info img, .result-vignette img').each((index, element) => {
        const $img = $(element);
        const src = $img.attr('src') || $img.attr('data-src');
        if (src && !src.startsWith('data:')) {
            const absoluteUrl = src.startsWith('http') ? src : `https://www.mmcriviera.com${src}`;
            details.images.push(absoluteUrl);
        }
    });

    return details;
};

const scrapeWatchDetails = async (watchUrl) => {
    try {
        const html = await fetchProductPage(watchUrl);
        if (!html) return null;
        
        const details = extractWatchDetails(html, watchUrl);
        return details;
    } catch (error) {
        console.error(`Error scraping watch details from ${watchUrl}:`, error.message);
        return null;
    }
};

const scrapeAllWatchDetails = async (urls) => {
    try {
        if (!urls || urls.length === 0) {
            console.log('No product URLs provided.');
            return [];
        }

        console.log(`\nStarting to scrape watch details from ${urls.length} product URLs...`);
        
        const watchData = [];
        const BATCH_SIZE = 10; // Process 10 products at a time
        const DELAY_BETWEEN_REQUESTS = 500; // 500ms delay between requests

        for (let i = 0; i < urls.length; i += BATCH_SIZE) {
            const batch = urls.slice(i, i + BATCH_SIZE);
            console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(urls.length / BATCH_SIZE)} (products ${i + 1}-${Math.min(i + BATCH_SIZE, urls.length)})...`);
            
            const batchPromises = batch.map((url, index) => 
                wait(index * DELAY_BETWEEN_REQUESTS).then(() => scrapeWatchDetails(url))
            );
            
            const batchResults = await Promise.allSettled(batchPromises);
            
            for (let j = 0; j < batchResults.length; j++) {
                const result = batchResults[j];
                if (result.status === 'fulfilled' && result.value) {
                    watchData.push({
                        index: watchData.length + 1,
                        ...result.value
                    });
                    console.log(`  ✓ Scraped: ${result.value.brand} ${result.value.model}`);
                } else {
                    console.log(`  ✗ Failed: ${batch[j]}`);
                }
            }
            
            // Delay between batches
            if (i + BATCH_SIZE < urls.length) {
                await wait(1000);
            }
        }

        // Save watch data
        fs.writeFileSync('watchData.json', JSON.stringify(watchData, null, 2));
        console.log(`\n✓ Scraped ${watchData.length} watch details. Saved to watchData.json`);

        // Post to backend
        if (CONFIG.BACK_END_URL) {
            try {
                const response = await axios.post(CONFIG.BACK_END_URL, {
                    parentUrl: CONFIG.PARENT_URL,
                    watchData: watchData
                });
                console.log('Posted watch data to backend:', response.status);
            } catch (postErr) {
                console.log('Post to backend failed:', postErr.message);
            }
        }

        return watchData;
    } catch (error) {
        console.error('Error scraping watch details:', error.message);
        return [];
    }
};

const scrapeProductUrls = async () => {
    try {
        const urlData = await getAllProductUrls();
        return urlData.availableUrls;
    } catch (error) {
        console.error('Error scraping product URLs:', error.message);
        return [];
    }
};

const startScheduler = async () => {
    const SCRAPE_INTERVAL = CONFIG.CHECK_INTERVAL || 10 * 60 * 60 * 1000;
    console.log('Initial scrape...');
    
    // First, scrape product URLs
    const urls = await scrapeProductUrls();
    
    // Then, scrape watch details from product URLs
    await scrapeAllWatchDetails(urls);
    
    setInterval(async () => {
        try {
            const urls = await scrapeProductUrls();
            await scrapeAllWatchDetails(urls);
        } catch (error) {
            console.error('Scheduled scrape error:', error.message);
        }
    }, SCRAPE_INTERVAL);
};

// Run immediately
startScheduler();
