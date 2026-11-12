import http from 'node:http';
import { postHttps, upstreamErrorCode } from './upstream-https.mjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { classifyDocuments } from './document-extraction.mjs';
import { allowedSections, compareNames, editableFields, extractionFields, hasRecordedConsent, savedPanName } from './public/workflow.js';

const env = process.env;
const webhook = 'https://icluster.imfast.co.in/api/v1/msme/bot-onboarding';
const fixedImageUrl = 'https://miro.medium.com/v2/resize:fit:1100/format:webp/1*PD78AUeGHG237G858-3ZsA.jpeg';
const channel = env.BOT_CHANNEL || 'PROTOTYPE';
const port = Number(env.PORT || 3002);
const host = env.HOST || '127.0.0.1';
const megabyte = 1024 * 1024;
const lifetime = 10 * 60 * 1000;
const active = new Set();
const drafts = new Map();
let draftBytes = 0;
const imageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
const docTypes = [...imageTypes, 'application/pdf'];
const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/collage.js', ['collage.js', 'text/javascript']],
  ['/workflow.js', ['workflow.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
  ['/logo.png', ['logo.png', 'image/png']],
  ['/icon-192.png', ['icon-192.png', 'image/png']],
  ['/sw.js', ['sw.js', 'text/javascript']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']]
]);

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

function date(value) {
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value || '')) return value;
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value.split('-').reverse().join('/') : undefined;
}

function mappings(bundle) {
  const { udyam, pan, acc, fssai } = bundle;
  return [
    ['udyam', udyam, { number: udyam?.udyamNo }],
    ['pan', pan, { number: pan?.panNo, name: pan?.name, dob: date(pan?.dob) }],
    ['bank', acc, { accountNumber: acc?.accountNumber, ifsc: acc?.ifsc }],
    ['fssai', fssai, { number: fssai?.number, expiryDate: date(fssai?.expiryDate) }]
  ];
}

function deleteDraft(token) {
  const draft = drafts.get(token);
  if (!draft) return;
  clearTimeout(draft.timer);
  draftBytes -= draft.bytes;
  drafts.delete(token);
}

async function extract(form, mobile) {
  if (form.get('accepted') !== 'true') fail('Accept the data collection notice before extracting documents.');
  if (!env.GEMINI_API_KEY) fail('Configure GEMINI_API_KEY on the PWA server.', 503);
  const files = form.getAll('documents');
  const bytes = files.reduce((sum, file) => sum + (file.size || 0), 0);
  if (!files.length || files.length > 8 || bytes > 12 * megabyte) fail('Choose one to eight documents totalling at most 12 MB.');
  if (files.some(file => !file.size || file.size > 10 * megabyte || !docTypes.includes(file.type))) fail('Choose JPG, PNG, WebP, HEIC or PDF documents up to 10 MB each.');
  let result;
  const collage = form.get('collage');
  if (files.length > 1 && (!collage?.size || collage.size > 10 * megabyte || collage.type !== 'image/jpeg')) {
    fail('The combined document image is missing or too large.');
  }
  try { result = await classifyDocuments(files, env, files.length > 1 ? collage : null); }
  catch (error) { fail(error.message || 'Document extraction failed.', 422); }
  if (result.conflicts.length) fail(result.conflicts.join(' ') + ' Upload one document per type.', 422);
  const nameMatch = compareNames(result.extraction);
  if (draftBytes + bytes > 64 * megabyte || drafts.size >= 16) fail('Document review is busy. Try again shortly.', 503);
  const token = randomBytes(32).toString('base64url');
  const timer = setTimeout(() => deleteDraft(token), 15 * 60 * 1000).unref();
  drafts.set(token, { mobile, bytes, result, nameMatch, timer });
  draftBytes += bytes;
  return json({ token, extraction: result.extraction, unclassified: result.unclassified, nameMatch });
}

async function prepare(form, payload, status) {
  if (form.get('accepted') !== 'true') fail('Accept the data collection notice before submitting.');
  const allowed = allowedSections(status);
  if (form.get('consent') !== 'true') fail('Accept the verification and onboarding consent before submitting.');

  const warnings = [];
  const token = form.get('reviewToken');
  if (token) {
    const draft = drafts.get(token);
    if (!draft || draft.mobile !== payload.merchantMobile) fail('The document review expired. Extract the documents again.', 409);
    let edits;
    try { edits = JSON.parse(form.get('edits') || '{}'); }
    catch { fail('The document edits could not be read.'); }
    if (!edits || typeof edits !== 'object' || Array.isArray(edits)) fail('Invalid document edits.');
    const bundle = structuredClone(draft.result.extraction);
    for (const [type, changes] of Object.entries(edits)) {
      if (!Object.hasOwn(extractionFields, type) || !bundle[type] || !changes || typeof changes !== 'object' || Array.isArray(changes)) fail('Invalid document edits.');
      for (const [field, value] of Object.entries(changes)) {
        if (!editableFields(type).includes(field) || typeof value !== 'string' || value.length > 500) fail('Invalid document field.');
        bundle[type][field] = value.trim() || null;
      }
    }
    let excluded;
    try { excluded = JSON.parse(form.get('excludedTypes') || '[]'); }
    catch { fail('The removed documents could not be read.'); }
    if (!Array.isArray(excluded) || excluded.some(type => !Object.hasOwn(bundle, type))) fail('Invalid removed documents.');
    for (const type of excluded) delete bundle[type];
    if (compareNames(bundle, savedPanName(status)).requiresRisk && form.get('acceptRisk') !== 'true') fail('Review the name differences before submitting.');
    const target = form.get('target');
    for (const [key, doc, fields] of mappings(bundle)) {
      if (!doc || (target && target !== key)) continue;
      if (!allowed.has(key)) { warnings.push(key + ' was skipped because it is no longer pending.'); continue; }
      const values = Object.fromEntries(Object.entries(fields).filter(([, value]) => value));
      // Complete document values satisfy the webhook without evidence.
      if (Object.keys(values).length < Object.keys(fields).length) values.imageUrl = fixedImageUrl;
      payload[key] = values;
    }
    if (bundle.gst) warnings.push('GST was extracted for review. The onboarding API has no GST field.');
    if (Object.keys(bundle.otherDocs || {}).length || draft.result.unclassified.length) warnings.push('Other documents were kept in the review only.');
  }
  for (const key of ['shopPhoto', 'ownerPhoto']) {
    const photo = form.get(key);
    if (!photo || !allowed.has(key)) continue;
    if (!photo.size || photo.size > 10 * megabyte || !imageTypes.includes(photo.type)) fail('Choose a supported shop or merchant image up to 10 MB.');
    payload[key] = { imageUrl: fixedImageUrl };
  }
  const lat = form.get('latitude'), lon = form.get('longitude');
  if (allowed.has('location') && (lat !== null || lon !== null)) {
    if (typeof lat !== 'string' || typeof lon !== 'string' || !lat.trim() || !lon.trim() ||
        !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon)) ||
        Math.abs(Number(lat)) > 90 || Math.abs(Number(lon)) > 180) fail('Capture a valid location.');
    payload.location = { latitude: Number(lat), longitude: Number(lon) };
  }
  if (Object.keys(payload).length === 2 && hasRecordedConsent(status)) fail(warnings.join(' ') || 'Add a pending item before submitting.');
  payload.consent = true;
  return warnings;
}

function postWebhook(payload) {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json', 'X-API-Key': env.BOT_API_KEY };
  return postHttps(webhook, headers, Buffer.from(JSON.stringify(payload)));
}

async function callWebhook(payload, operation) {
  const id = randomUUID().slice(0, 8);
  const started = Date.now();
  const host = new URL(webhook).hostname;
  const statusCheck = operation === 'status';
  let result;
  try {
    result = await postWebhook(payload);
  } catch (error) {
    const code = upstreamErrorCode(error);
    console.error('[IMOO webhook ' + id + '] ' + JSON.stringify({
      operation, host, code, elapsedMs: Date.now() - started
    }));
    let message;
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
      message = 'This server could not resolve ' + host + '. Check DNS or your work network.';
    } else if (['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'ECONNREFUSED'].includes(code)) {
      message = 'Could not connect to ' + host + ' over HTTPS.';
    } else if (code === 'TimeoutError') {
      message = statusCheck ? 'The onboarding status request timed out.' : 'The backend may still be processing your submission.';
    } else {
      message = 'The onboarding backend could not be reached.';
    }
    const next = statusCheck ? ' Try Continue again once the backend is reachable.' : ' Refresh status before resubmitting.';
    fail(message + next + ' Reference: ' + id + '.', 504);
  }
  if (!result.ok) console.error('[IMOO webhook ' + id + '] ' + JSON.stringify({
    operation, host, status: result.status, elapsedMs: Date.now() - started
  }));
  const data = await result.json().catch(() => null);
  if (result.ok && data && Array.isArray(data.pending) && data.documents && typeof data.onboardingStatus === 'string') return json(data);
  const messages = {
    401: 'The backend rejected the API key. Check BOT_API_KEY.',
    403: 'Onboarding is not enabled for this mobile. Contact the MSME Cluster team.',
    429: 'The backend is already processing this mobile. Wait at least 5 seconds, then refresh status.',
    500: statusCheck ? 'The backend could not check onboarding status. Try again shortly.' : 'The backend could not complete the request. Refresh status before resubmitting.'
  };
  return json({ message: messages[result.status] || data?.message || 'The backend returned an unexpected response.',
    errors: result.status === 400 ? data?.errors : undefined }, result.ok ? 502 : result.status,
    result.status === 429 ? { 'Retry-After': result.headers.get('Retry-After') || '5' } : {});
}

async function route(request) {
  const url = new URL(request.url);
  if (request.method === 'GET') {
    if (url.pathname === '/api/config') return json({ photos: true });
    if (url.pathname === '/pdf.mjs' || url.pathname === '/pdf.worker.mjs') {
      const file = await readFile(new URL('./node_modules/pdfjs-dist/build' + url.pathname, import.meta.url)).catch(() => null);
      if (!file) return json({ message: 'Install the PDF rendering dependency with npm install.' }, 404);
      return new Response(file, { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' } });
    }
    const asset = assets.get(url.pathname);
    if (asset) return new Response(await readFile(new URL('./public/' + asset[0], import.meta.url)), {
      headers: { 'Content-Type': asset[1], 'Cache-Control': 'no-cache', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' blob: data: https:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'" }
    });
  }
  if (request.method !== 'POST' || !['/api/status', '/api/extract', '/api/submit', '/api/cancel-review'].includes(url.pathname)) return json({ message: 'Not found.' }, 404);
  if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) fail('Invalid request origin.', 403);
  if (!env.BOT_API_KEY) fail('Configure BOT_API_KEY on the PWA server.', 503);
  if (!['PROTOTYPE', 'VIDEO_KYC'].includes(channel)) fail('Set BOT_CHANNEL to PROTOTYPE or VIDEO_KYC.', 503);
  const extracting = url.pathname === '/api/extract';
  const submitting = url.pathname === '/api/submit';
  const multipart = extracting || submitting;
  let input;
  try { input = multipart ? await request.formData() : await request.json(); }
  catch { fail('The request could not be read.'); }
  const mobile = multipart ? input.get('mobile') : input?.mobile;
  if (typeof mobile !== 'string' || !/^[6-9]\d{9}$/.test(mobile)) fail('Enter a valid 10-digit mobile number.');
  if (url.pathname === '/api/cancel-review') {
    if (drafts.get(input.token)?.mobile === mobile) deleteDraft(input.token);
    return json({ cancelled: true });
  }
  if (active.has(mobile)) fail('A request is already running for this mobile. Please wait.', 429);
  active.add(mobile);
  try {
    if (extracting) return await extract(input, mobile);
    const payload = { merchantMobile: mobile, channel };
    const current = await callWebhook(payload, 'status');
    if (!submitting || !current.ok) return current;
    const warnings = await prepare(input, payload, await current.json());
    const result = await callWebhook(payload, 'submit');
    if (!result.ok) return result;
    if (!input.get('target')) deleteDraft(input.get('reviewToken'));
    return json({ ...await result.json(), uploadWarnings: warnings, submittedSections: Object.keys(payload).filter(key => key !== 'merchantMobile' && key !== 'channel') });
  } finally {
    active.delete(mobile);
  }
}

http.createServer(async (req, res) => {
  let response;
  try {
    const protocol = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const url = new URL(req.url, protocol + '://' + req.headers.host);
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 34 * megabyte) fail('The upload is too large.', 413);
      chunks.push(chunk);
    }
    response = await route(new Request(url, { method: req.method, headers: req.headers,
      body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }));
  } catch (error) {
    response = json({ message: error.status ? error.message : 'Unable to complete this request.' }, error.status || 500,
      error.status === 429 ? { 'Retry-After': '5' } : {});
  }
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, host, () => console.log('IMOO PWA running on http://' + host + ':' + port));
