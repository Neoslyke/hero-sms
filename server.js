const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Search and load .env from multiple candidate paths
const candidateEnvPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '.env'),
  '/app/.env',
  path.resolve(__dirname, '..', '.env'),
  path.resolve(__dirname, 'hero-sms', '.env')
];

let loadedEnvPath = null;
for (const p of candidateEnvPaths) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    loadedEnvPath = p;
    break;
  }
}
if (!loadedEnvPath) {
  dotenv.config();
}

const express = require('express');

const app = express();
const PORT = process.env.PORT || 3001;
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/$/, ''); // e.g. '/hero-sms'
const HERO_API_HOST = process.env.HERO_API_HOST || 'https://hero-sms.com/stubs/handler_api.php';

// Malaysia constants
const MALAYSIA_COUNTRY_ID = 7;
const MALAYSIA_PHONE_CODE = 60;
const DURATION_SECONDS = 20 * 60; // 20 minutes

// Middleware
app.use(express.json());

// Helper to determine clean API key exclusively from server .env
function getCleanApiKey() {
  const raw = process.env.HERO_SMS_API_KEY || process.env.API_KEY || '';
  return String(raw).trim().replace(/^["']|["']$/g, '');
}

// Helper to call HeroSMS API
async function callHeroApi(action, params = {}, apiKey = '') {
  const query = new URLSearchParams({
    action,
    api_key: apiKey,
    ...params
  });
  const url = `${HERO_API_HOST}?${query.toString()}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*'
      }
    });

    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }

    return { ok: res.ok, status: res.status, text, json };
  } catch (err) {
    return { ok: false, status: 500, error: err.message };
  }
}

// Pre-defined featured services for Malaysia
const FEATURED_SERVICES = [
  { code: 'fz', name: 'KFC', icon: '🍗', category: 'Food & Dining', price: '0.07' },
  { code: 'bwx', name: 'Chagee', icon: '🧋', category: 'Fresh Milk Tea', price: '0.07' },
  { code: 'aik', name: 'ZUS Coffee', icon: '☕', category: 'Specialty Coffee', price: '0.07' },
  { code: 'ot', name: 'General', icon: '🌐', category: 'General Apps', price: '0.07' }
];

// In-memory cache for full service list
let cachedServices = null;
let cachedServicesTime = 0;

// Helper: Convert to Malaysian local format (e.g. 601163112901 -> 01163112901)
function toMalaysiaLocalNumber(phone) {
  let cleaned = String(phone).replace(/\D/g, '');
  if (cleaned.startsWith('60')) {
    cleaned = '0' + cleaned.slice(2);
  } else if (!cleaned.startsWith('0')) {
    cleaned = '0' + cleaned;
  }
  return cleaned;
}

// Helper: Format Malaysian local phone for display (e.g. 011-6311 2901 or 012-345 6789)
function formatMalaysiaDisplayPhone(phone) {
  const local = toMalaysiaLocalNumber(phone);
  if (local.startsWith('011') && local.length >= 10) {
    return `${local.slice(0, 3)}-${local.slice(3, 7)} ${local.slice(7)}`;
  } else if (local.length >= 10) {
    return `${local.slice(0, 3)}-${local.slice(3, 6)} ${local.slice(6)}`;
  } else if (local.length >= 6) {
    return `${local.slice(0, 3)}-${local.slice(3)}`;
  }
  return local;
}

// Helper: Format international phone (+60 11-6311 2901)
function formatMalaysiaInternationalPhone(phone) {
  const local = toMalaysiaLocalNumber(phone);
  const rest = local.slice(1);
  if (rest.startsWith('11') && rest.length >= 9) {
    return `+60 ${rest.slice(0, 2)}-${rest.slice(2, 6)} ${rest.slice(6)}`;
  } else if (rest.length >= 8) {
    return `+60 ${rest.slice(0, 2)}-${rest.slice(2, 5)} ${rest.slice(5)}`;
  }
  return `+60 ${rest}`;
}

// Server-side active sessions store (persisted to file so sessions survive refreshes and restarts)
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (DATA_DIR && !fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}
const SESSIONS_FILE = path.join(DATA_DIR, 'active-sessions.json');
const activeSessions = new Map();

function loadSessionsFromFile() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        const now = Date.now();
        for (const item of list) {
          if (item && item.activationId) {
            // Keep active if within 25 minutes
            const elapsed = now - (item.startTime || now);
            if (elapsed < 25 * 60 * 1000) {
              activeSessions.set(String(item.activationId), item);
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('Failed to load active-sessions.json:', err.message);
  }
}

function saveSessionsToFile() {
  try {
    const list = Array.from(activeSessions.values());
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (err) {
    console.warn('Failed to save active-sessions.json:', err.message);
  }
}

// Auto-handle activations that have reached the 20-minute validity period
// Per Hero-SMS API documentation & policy:
// - If SMS code was received: auto-confirm / complete (funds finalized, not refunded)
// - If NO SMS code was received: auto-cancel & refund funds back to wallet balance
async function processExpiredSessions() {
  const apiKey = getCleanApiKey();
  if (activeSessions.size === 0) return;

  const now = Date.now();
  const toProcess = [];

  for (const [id, s] of activeSessions.entries()) {
    const elapsed = now - (s.startTime || now);
    if (elapsed >= DURATION_SECONDS * 1000) {
      toProcess.push(s);
    }
  }

  for (const session of toProcess) {
    const id = session.activationId;
    if (session.code) {
      // Case A: SMS was received -> Auto-confirm on Hero-SMS (funds finalized)
      console.log(`[Auto-Confirm] 20m expired for ${id} (${session.serviceName}). Code was received (${session.code}). Finalizing with Hero-SMS.`);
      if (apiKey) {
        try {
          await callHeroApi('finishActivation', { id }, apiKey);
          await callHeroApi('setStatus', { id, status: 6 }, apiKey);
        } catch (err) {
          console.warn(`Error auto-confirming session ${id}:`, err.message);
        }
      }
    } else {
      // Case B: No SMS received -> Auto-cancel on Hero-SMS and refund balance
      console.log(`[Auto-Refund] 20m expired for ${id} (${session.serviceName}). No SMS received. Canceling with Hero-SMS for full refund.`);
      if (apiKey) {
        try {
          await callHeroApi('cancelActivation', { id }, apiKey);
          await callHeroApi('setStatus', { id, status: 8 }, apiKey);
        } catch (err) {
          console.warn(`Error auto-canceling session ${id}:`, err.message);
        }
      }
    }
    activeSessions.delete(id);
  }

  if (toProcess.length > 0) {
    saveSessionsToFile();
  }
}

// Check every 15 seconds for automatic expiration handling on the server
setInterval(processExpiredSessions, 15000);

// Load on startup
loadSessionsFromFile();
processExpiredSessions();

// API Routes
const api = express.Router();

// 1. App Configuration
api.get('/config', (req, res) => {
  const apiKey = getCleanApiKey();
  res.json({
    success: true,
    hasServerApiKey: Boolean(apiKey),
    basePath: BASE_PATH,
    country: {
      id: MALAYSIA_COUNTRY_ID,
      name: 'Malaysia',
      code: `+${MALAYSIA_PHONE_CODE}`,
      flag: '🇲🇾'
    },
    verificationType: 'sms',
    durationMinutes: 20
  });
});

// 2. Wallet Balance
api.get('/balance', async (req, res) => {
  const apiKey = getCleanApiKey();
  if (!apiKey) {
    return res.status(401).json({
      success: false,
      error: 'Hero-SMS API key not set in .env on server. Please configure HERO_SMS_API_KEY in .env.'
    });
  }

  const result = await callHeroApi('getBalance', {}, apiKey);

  if (result.error) {
    return res.status(502).json({ success: false, error: `Connection failed: ${result.error}` });
  }

  const text = result.text.trim();

  // Handle ACCESS_BALANCE:xxx
  if (text.startsWith('ACCESS_BALANCE:')) {
    const rawAmount = text.split(':')[1];
    const balance = parseFloat(rawAmount) || 0;
    return res.json({
      success: true,
      balance,
      formatted: balance.toFixed(2),
      raw: text
    });
  }

  // Handle JSON errors or strings
  if (result.json) {
    if (result.json.title === 'BAD_KEY') {
      return res.status(401).json({ success: false, error: 'Invalid API Key. Please verify your token.' });
    }
    return res.status(400).json({ success: false, error: result.json.details || result.json.title || 'Error fetching balance' });
  }

  if (text === 'BAD_KEY') {
    return res.status(401).json({ success: false, error: 'Invalid API Key. Please verify your token.' });
  }

  res.status(400).json({ success: false, error: `Unexpected response: ${text}` });
});

// 3. Services List (Malaysia only, sorted by name with price info)
api.get('/services', async (req, res) => {
  const now = Date.now();
  // Return cached full list if younger than 30 minutes
  if (cachedServices && (now - cachedServicesTime < 1800 * 1000)) {
    return res.json({
      success: true,
      featured: FEATURED_SERVICES,
      all: cachedServices
    });
  }

  const apiKey = getCleanApiKey();
  const [result, pricesRes] = await Promise.all([
    callHeroApi('getServicesList', { country: MALAYSIA_COUNTRY_ID }, apiKey),
    apiKey ? callHeroApi('getPrices', { country: MALAYSIA_COUNTRY_ID }, apiKey) : Promise.resolve({})
  ]);

  // Parse prices map for Malaysia
  let pricesMap = {};
  try {
    if (pricesRes && pricesRes.json) {
      if (pricesRes.json[String(MALAYSIA_COUNTRY_ID)]) {
        pricesMap = pricesRes.json[String(MALAYSIA_COUNTRY_ID)];
      } else if (typeof pricesRes.json === 'object') {
        pricesMap = pricesRes.json;
      }
    }
  } catch {}

  // Update featured services with live prices
  for (const f of FEATURED_SERVICES) {
    if (pricesMap[f.code] && pricesMap[f.code].cost) {
      f.price = Number(pricesMap[f.code].cost).toFixed(2);
    } else {
      f.price = f.price || '0.07';
    }
  }

  let servicesList = [];
  if (result.json && Array.isArray(result.json.services)) {
    servicesList = result.json.services;
  } else if (result.json && typeof result.json === 'object') {
    servicesList = Object.values(result.json).filter(s => s && s.code && s.name);
  }

  if (servicesList.length > 0) {
    // Attach prices
    servicesList = servicesList.map(s => {
      let price = '0.07';
      if (pricesMap[s.code] && pricesMap[s.code].cost) {
        price = Number(pricesMap[s.code].cost).toFixed(2);
      }
      return {
        code: s.code,
        name: s.name,
        price
      };
    });

    // Sort list by Name alphabetically (A-Z) instead of ID/code
    servicesList.sort((a, b) => (a.name || a.code || '').localeCompare(b.name || b.code || '', undefined, { sensitivity: 'base' }));

    cachedServices = servicesList;
    cachedServicesTime = now;
  }

  res.json({
    success: true,
    featured: FEATURED_SERVICES,
    all: cachedServices || FEATURED_SERVICES
  });
});

// 4. Request Temporary Number
api.post('/number', async (req, res) => {
  const apiKey = getCleanApiKey();
  if (!apiKey) {
    return res.status(401).json({ success: false, error: 'Hero-SMS API key not set in .env.' });
  }

  const service = (req.body.service || '').trim().toLowerCase();
  if (!service) {
    return res.status(400).json({ success: false, error: 'Service code is required.' });
  }

  // Call getNumberV2 first
  const result = await callHeroApi('getNumberV2', {
    service,
    country: MALAYSIA_COUNTRY_ID
  }, apiKey);

  if (result.error) {
    return res.status(502).json({ success: false, error: `Failed to contact Hero-SMS: ${result.error}` });
  }

  // Helper to match service details
  const matchFeatured = FEATURED_SERVICES.find(f => f.code === service);
  const serviceName = matchFeatured ? matchFeatured.name : service.toUpperCase();
  const serviceIcon = matchFeatured ? matchFeatured.icon : '📱';

  // Case 1: Structured JSON response
  if (result.json && result.json.activationId) {
    const item = result.json;
    const rawPhone = String(item.phoneNumber);
    const local = toMalaysiaLocalNumber(rawPhone);
    const formatted = formatMalaysiaDisplayPhone(rawPhone);
    const intl = formatMalaysiaInternationalPhone(rawPhone);

    const sessionItem = {
      activationId: String(item.activationId),
      phoneNumber: rawPhone,
      localPhone: local,
      formattedPhone: formatted,
      internationalPhone: intl,
      cost: item.activationCost || 0,
      currency: item.currency || 'USD',
      serviceCode: item.serviceCode || service,
      serviceName,
      serviceIcon,
      countryCode: item.countryCode || MALAYSIA_COUNTRY_ID,
      durationSeconds: DURATION_SECONDS,
      startTime: Date.now(),
      createdAt: item.activationTime || new Date().toISOString(),
      code: null,
      smsText: null,
      status: 'WAIT_CODE'
    };

    activeSessions.set(sessionItem.activationId, sessionItem);
    saveSessionsToFile();

    return res.json({
      success: true,
      ...sessionItem
    });
  }

  const text = (result.text || '').trim();

  // Case 2: Standard SMS-Activate string response: ACCESS_NUMBER:activation_id:number
  if (text.startsWith('ACCESS_NUMBER:')) {
    const parts = text.split(':');
    const activationId = String(parts[1]);
    const rawPhone = String(parts[2]);
    const local = toMalaysiaLocalNumber(rawPhone);
    const formatted = formatMalaysiaDisplayPhone(rawPhone);
    const intl = formatMalaysiaInternationalPhone(rawPhone);

    const sessionItem = {
      activationId,
      phoneNumber: rawPhone,
      localPhone: local,
      formattedPhone: formatted,
      internationalPhone: intl,
      cost: 0,
      currency: 'USD',
      serviceCode: service,
      serviceName,
      serviceIcon,
      countryCode: MALAYSIA_COUNTRY_ID,
      durationSeconds: DURATION_SECONDS,
      startTime: Date.now(),
      createdAt: new Date().toISOString(),
      code: null,
      smsText: null,
      status: 'WAIT_CODE'
    };

    activeSessions.set(sessionItem.activationId, sessionItem);
    saveSessionsToFile();

    return res.json({
      success: true,
      ...sessionItem
    });
  }

  // Handle common errors
  if (text === 'NO_NUMBERS' || (result.json && result.json.title === 'NO_NUMBERS')) {
    return res.status(404).json({
      success: false,
      code: 'NO_NUMBERS',
      error: 'No phone numbers are currently available for this service in Malaysia. Please try again in 1-2 minutes.'
    });
  }

  if (text === 'NO_BALANCE' || (result.json && result.json.title === 'NO_BALANCE')) {
    return res.status(402).json({
      success: false,
      code: 'NO_BALANCE',
      error: 'Insufficient account balance on Hero-SMS. Please top up your wallet.'
    });
  }

  if (text === 'BAD_KEY' || (result.json && result.json.title === 'BAD_KEY')) {
    return res.status(401).json({
      success: false,
      code: 'BAD_KEY',
      error: 'Invalid API Key. Please verify your Hero-SMS API key.'
    });
  }

  if (text === 'BAD_SERVICE' || (result.json && result.json.title === 'BAD_SERVICE')) {
    return res.status(400).json({
      success: false,
      code: 'BAD_SERVICE',
      error: 'Invalid service selected.'
    });
  }

  const detail = (result.json && (result.json.details || result.json.title)) || text;
  res.status(400).json({ success: false, error: `Order failed: ${detail}` });
});

// 5. Check Activation Status / Polling
api.get('/status/:id', async (req, res) => {
  const apiKey = getCleanApiKey();
  if (!apiKey) {
    return res.status(401).json({ success: false, error: 'Hero-SMS API key not set in .env.' });
  }

  const id = req.params.id;

  // Query getStatus
  const result = await callHeroApi('getStatus', { id }, apiKey);

  if (result.error) {
    return res.status(502).json({ success: false, error: result.error });
  }

  const text = (result.text || '').trim();
  const now = Date.now();
  const session = activeSessions.get(id);
  const elapsed = session ? (now - (session.startTime || now)) : 0;

  // Check if 20-minute validity period has elapsed
  if (session && elapsed >= DURATION_SECONDS * 1000) {
    if (session.code || text.startsWith('STATUS_OK:')) {
      const finalCode = session.code || text.slice('STATUS_OK:'.length).trim();
      try {
        await callHeroApi('finishActivation', { id }, apiKey);
        await callHeroApi('setStatus', { id, status: 6 }, apiKey);
      } catch {}
      activeSessions.delete(id);
      saveSessionsToFile();
      return res.json({
        success: true,
        status: 'AUTO_CONFIRMED',
        code: finalCode,
        smsText: session.smsText || `Verification code: ${finalCode}`,
        message: '20-minute validity period expired. Activation auto-confirmed on Hero-SMS.'
      });
    } else {
      try {
        await callHeroApi('cancelActivation', { id }, apiKey);
        await callHeroApi('setStatus', { id, status: 8 }, apiKey);
      } catch {}
      activeSessions.delete(id);
      saveSessionsToFile();
      return res.json({
        success: true,
        status: 'AUTO_CANCELLED',
        message: '20-minute validity period expired with no SMS. Auto-canceled and refunded on Hero-SMS.'
      });
    }
  }

  // STATUS_OK:<code>
  if (text.startsWith('STATUS_OK:')) {
    const code = text.slice('STATUS_OK:'.length).trim();

    // Optionally fetch full SMS text using getAllSms
    let fullSmsText = `Verification code: ${code}`;
    let sender = '';
    try {
      const smsRes = await callHeroApi('getAllSms', { id }, apiKey);
      if (smsRes.json && Array.isArray(smsRes.json.data) && smsRes.json.data.length > 0) {
        const latest = smsRes.json.data[smsRes.json.data.length - 1];
        if (latest.text) fullSmsText = latest.text;
        if (latest.phoneFrom) sender = latest.phoneFrom;
      }
    } catch {
      // ignore
    }

    const session = activeSessions.get(id);
    if (session) {
      session.code = code;
      session.smsText = fullSmsText;
      session.status = 'OK';
      saveSessionsToFile();
    }

    return res.json({
      success: true,
      status: 'OK',
      code,
      smsText: fullSmsText,
      sender
    });
  }

  if (text === 'STATUS_WAIT_CODE') {
    return res.json({
      success: true,
      status: 'WAIT_CODE',
      message: 'Waiting for incoming SMS...'
    });
  }

  if (text === 'STATUS_WAIT_RETRY') {
    return res.json({
      success: true,
      status: 'WAIT_RETRY',
      message: 'Waiting for SMS code retry...'
    });
  }

  if (text === 'STATUS_WAIT_RESEND') {
    return res.json({
      success: true,
      status: 'WAIT_RESEND',
      message: 'Waiting for SMS resend...'
    });
  }

  if (text === 'STATUS_CANCEL') {
    activeSessions.delete(id);
    saveSessionsToFile();
    return res.json({
      success: true,
      status: 'CANCEL',
      message: 'Activation was canceled / refunded.'
    });
  }

  if (result.json && result.json.title === 'BAD_KEY') {
    return res.status(401).json({ success: false, error: 'Invalid API key.' });
  }

  res.json({
    success: true,
    status: 'UNKNOWN',
    raw: text
  });
});

// 6. Cancel Activation (Refund) - with Hero-SMS API verification
api.post('/cancel/:id', async (req, res) => {
  const apiKey = getCleanApiKey();
  if (!apiKey) {
    return res.status(401).json({ success: false, error: 'Hero-SMS API key not set in .env.' });
  }

  const id = req.params.id;

  // Step 1: Check status with Hero-SMS
  const statusRes = await callHeroApi('getStatus', { id }, apiKey);
  const statusText = (statusRes.text || '').trim();

  // If already canceled on Hero-SMS
  if (statusText === 'STATUS_CANCEL') {
    activeSessions.delete(id);
    saveSessionsToFile();
    return res.json({
      success: true,
      message: 'Activation was already canceled on Hero-SMS.'
    });
  }

  // If SMS has arrived, Hero-SMS forbids cancellation
  if (statusText.startsWith('STATUS_OK:')) {
    return res.status(409).json({
      success: false,
      code: 'OTP_RECEIVED',
      error: 'Cannot cancel activation: an SMS verification code has already arrived for this number. Please click "Complete Activation" instead.'
    });
  }

  // Step 2: Call cancelActivation
  let result = await callHeroApi('cancelActivation', { id }, apiKey);
  const text = (result.text || '').trim();

  const isSuccess = (result.status === 204) || 
                    text === 'ACCESS_CANCEL' || 
                    (result.json && result.json.status === 'ACCESS_CANCEL');

  if (isSuccess) {
    activeSessions.delete(id);
    saveSessionsToFile();
    return res.json({
      success: true,
      message: 'Activation canceled successfully on Hero-SMS. Funds refunded.'
    });
  }

  // Check if Hero-SMS explicitly returned EARLY_CANCEL_DENIED or OTP_RECEIVED
  const errJson = result.json;
  if (errJson && errJson.title === 'EARLY_CANCEL_DENIED') {
    const minSec = (errJson.info && errJson.info.minActivationTime) || 120;
    return res.status(409).json({
      success: false,
      code: 'EARLY_CANCEL_DENIED',
      minActivationTime: minSec,
      error: 'Cancellation locked by Hero-SMS policy. You must wait 2 minutes (120s) after purchase before cancelling.'
    });
  }

  if (errJson && (errJson.title === 'OTP_RECEIVED' || errJson.title === 'CANCEL_DENIED_MESSAGE_RECEIVED')) {
    return res.status(409).json({
      success: false,
      code: 'OTP_RECEIVED',
      error: 'Cannot cancel: an SMS code has already been received on this number.'
    });
  }

  if (text.includes('EARLY_CANCEL_DENIED')) {
    return res.status(409).json({
      success: false,
      code: 'EARLY_CANCEL_DENIED',
      minActivationTime: 120,
      error: 'Cancellation locked by Hero-SMS policy. You must wait 2 minutes (120s) after purchase before cancelling.'
    });
  }

  // Step 3: Try setStatus=8 fallback
  const fallbackRes = await callHeroApi('setStatus', { id, status: 8 }, apiKey);
  const fallbackText = (fallbackRes.text || '').trim();

  if (fallbackRes.status === 204 || fallbackText === 'ACCESS_CANCEL') {
    activeSessions.delete(id);
    saveSessionsToFile();
    return res.json({
      success: true,
      message: 'Activation canceled successfully on Hero-SMS. Funds refunded.'
    });
  }

  const fallbackJson = fallbackRes.json;
  if (fallbackJson && fallbackJson.title === 'EARLY_CANCEL_DENIED') {
    return res.status(409).json({
      success: false,
      code: 'EARLY_CANCEL_DENIED',
      minActivationTime: 120,
      error: 'Cancellation locked by Hero-SMS policy. You must wait 2 minutes (120s) after purchase before cancelling.'
    });
  }

  const finalError = (errJson && (errJson.details || errJson.title)) ||
                     (fallbackJson && (fallbackJson.details || fallbackJson.title)) ||
                     text || fallbackText || 'Cancellation rejected by Hero-SMS API.';

  return res.status(400).json({
    success: false,
    error: `Hero-SMS rejected cancellation: ${finalError}`
  });
});

// 7. Complete Activation
api.post('/finish/:id', async (req, res) => {
  const apiKey = getCleanApiKey();
  if (!apiKey) {
    return res.status(401).json({ success: false, error: 'Hero-SMS API key not set in .env.' });
  }

  const id = req.params.id;

  // Try finishActivation first
  let result = await callHeroApi('finishActivation', { id }, apiKey);
  const text = (result.text || '').trim();

  if (result.status === 204 || text === 'ACCESS_ACTIVATION') {
    activeSessions.delete(id);
    saveSessionsToFile();
    return res.json({
      success: true,
      message: 'Activation completed on Hero-SMS.'
    });
  }

  // Fallback to setStatus & status=6
  const fallbackRes = await callHeroApi('setStatus', { id, status: 6 }, apiKey);
  const fallbackText = (fallbackRes.text || '').trim();

  if (fallbackRes.status === 204 || fallbackText === 'ACCESS_ACTIVATION') {
    activeSessions.delete(id);
    saveSessionsToFile();
    return res.json({
      success: true,
      message: 'Activation completed on Hero-SMS.'
    });
  }

  const errJson = result.json || fallbackRes.json;
  const detail = (errJson && (errJson.details || errJson.title)) || text || fallbackText || 'Failed to complete activation.';

  res.status(400).json({
    success: false,
    error: `Hero-SMS error: ${detail}`
  });
});

// 8. Active Activations List (Multi-Activation Support & Server Sync)
api.get('/active', async (req, res) => {
  const apiKey = getCleanApiKey();

  // 1. Process and auto-confirm/auto-cancel expired sessions (>= 20 mins)
  await processExpiredSessions();

  // 2. If API key is available, query Hero-SMS to discover remote activations
  if (apiKey) {
    try {
      const result = await callHeroApi('getActiveActivations', {}, apiKey);
      if (result.json && result.json.data && Array.isArray(result.json.data)) {
        const remoteIds = new Set();
        const now = Date.now();

        for (const item of result.json.data) {
          const actId = String(item.activationId);
          remoteIds.add(actId);
          const rawPhone = String(item.phoneNumber);
          const sCode = item.serviceCode || 'ot';
          const matchFeatured = FEATURED_SERVICES.find(f => f.code === sCode);

          let startTime = now;
          if (item.activationTime) {
            const parsed = new Date(item.activationTime).getTime();
            if (!isNaN(parsed)) startTime = parsed;
          }

          const existing = activeSessions.get(actId);
          activeSessions.set(actId, {
            activationId: actId,
            phoneNumber: rawPhone,
            localPhone: toMalaysiaLocalNumber(rawPhone),
            formattedPhone: formatMalaysiaDisplayPhone(rawPhone),
            internationalPhone: formatMalaysiaInternationalPhone(rawPhone),
            serviceCode: sCode,
            serviceName: matchFeatured ? matchFeatured.name : (existing ? existing.serviceName : sCode.toUpperCase()),
            serviceIcon: matchFeatured ? matchFeatured.icon : (existing ? existing.serviceIcon : '📱'),
            cost: item.activationCost || (existing ? existing.cost : 0),
            currency: item.currency || (existing ? existing.currency : 'USD'),
            countryCode: MALAYSIA_COUNTRY_ID,
            durationSeconds: DURATION_SECONDS,
            startTime: existing ? existing.startTime : startTime,
            code: (Array.isArray(item.smsCode) ? item.smsCode[0] : item.smsCode) || (existing ? existing.code : null),
            smsText: (Array.isArray(item.smsText) ? item.smsText[0] : item.smsText) || (existing ? existing.smsText : null),
            status: item.activationStatus || (existing ? existing.status : 'WAIT_CODE')
          });
        }

        // Prune any local session older than 2 minutes that is no longer returned in Hero-SMS's active list
        for (const [localId, localSession] of activeSessions.entries()) {
          const age = now - (localSession.startTime || now);
          if (age > 2 * 60 * 1000 && !remoteIds.has(localId)) {
            console.log(`Pruning inactive session ${localId} (no longer active on Hero-SMS)`);
            activeSessions.delete(localId);
          }
        }
      }
    } catch (err) {
      console.warn('Error syncing active activations with Hero-SMS:', err.message);
    }
  }

  saveSessionsToFile();

  const list = Array.from(activeSessions.values()).sort((a, b) => b.startTime - a.startTime);
  res.json({ success: true, activations: list });
});

// Mount API and static assets
const staticDir = path.join(__dirname, 'public');

// Canonical redirect for exact /hero-sms (no trailing slash) -> /hero-sms/
app.get(/^\/hero-sms$/, (req, res) => res.redirect(301, '/hero-sms/'));
if (BASE_PATH && BASE_PATH !== '/hero-sms') {
  app.get(new RegExp(`^${BASE_PATH}$`), (req, res) => res.redirect(301, `${BASE_PATH}/`));
}

// Explicit HTML index handlers
app.get(['/hero-sms/', '/hero-sms/index.html'], (req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});
if (BASE_PATH && BASE_PATH !== '/hero-sms') {
  app.get([`${BASE_PATH}/`, `${BASE_PATH}/index.html`], (req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });
}
app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});

// Mount API router on both /hero-sms/api and /api
app.use('/hero-sms/api', api);
if (BASE_PATH && BASE_PATH !== '/hero-sms') {
  app.use(`${BASE_PATH}/api`, api);
}
app.use('/api', api);

// Serve static assets on both /hero-sms and root
app.use('/hero-sms', express.static(staticDir, { redirect: false }));
if (BASE_PATH && BASE_PATH !== '/hero-sms') {
  app.use(BASE_PATH, express.static(staticDir, { redirect: false }));
}
app.use(express.static(staticDir, { redirect: false }));

// Fallback index.html for SPA
app.get('/hero-sms/*', (req, res) => res.sendFile(path.join(staticDir, 'index.html')));
if (BASE_PATH && BASE_PATH !== '/hero-sms') {
  app.get(`${BASE_PATH}/*`, (req, res) => res.sendFile(path.join(staticDir, 'index.html')));
}
app.get('*', (req, res) => res.sendFile(path.join(staticDir, 'index.html')));

// Helper: Format Malaysian phone numbers (+60 1x-xxx xxxx)
function formatMalaysiaPhone(phone) {
  let cleaned = String(phone).replace(/\D/g, '');
  if (!cleaned.startsWith('60')) {
    cleaned = '60' + cleaned;
  }
  // cleaned is like 60123456789
  const countryCode = '+60';
  const rest = cleaned.slice(2);
  if (rest.length >= 9) {
    return `${countryCode} ${rest.slice(0, 2)}-${rest.slice(2, 5)} ${rest.slice(5)}`;
  } else if (rest.length >= 7) {
    return `${countryCode} ${rest.slice(0, 2)}-${rest.slice(2)}`;
  }
  return `+${cleaned}`;
}

// Start server
app.listen(PORT, '0.0.0.0', () => {
  const currentKey = getCleanApiKey();
  const keyDisplay = currentKey
    ? `✅ LOADED (${currentKey.length > 8 ? currentKey.slice(0, 4) + '...' + currentKey.slice(-4) : '****'})`
    : '❌ NOT FOUND (Set HERO_SMS_API_KEY in .env)';

  console.log(`===============================================`);
  console.log(` Hero SMS Web App running on port ${PORT}`);
  console.log(` Base Path: ${BASE_PATH || '/'}`);
  console.log(` API Key Status: ${keyDisplay}`);
  console.log(` Environment Source: ${loadedEnvPath || 'System Environment Variables'}`);
  console.log(` Local URL: http://localhost:${PORT}${BASE_PATH || ''}`);
  console.log(` Malaysia Target: Country ID ${MALAYSIA_COUNTRY_ID} (+${MALAYSIA_PHONE_CODE})`);
  console.log(`===============================================`);
});
