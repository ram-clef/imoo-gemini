import { combineDocuments } from './collage.js';
import { allowedSections, compareNames, documentKeys, editableFields, extractionFields, hasRecordedConsent, reviewFields, savedPanName } from './workflow.js';

const $ = id => document.getElementById(id);
const labels = { udyam: 'Udyam', pan: 'PAN', bank: 'Bank document', fssai: 'FSSAI', shopPhoto: 'Shop photo', ownerPhoto: 'Merchant photo', location: 'Shop location', consent: 'Consent' };
const types = { udyam: 'udyam', pan: 'pan', bank: 'acc', fssai: 'fssai' };
const state = { mobile: '', status: null, accepted: false, files: [], review: null, approved: false,
  shopPhoto: null, ownerPhoto: null, location: null, busy: false, needsRefresh: false };
const previews = new Map();
const summaryUrls = [];
const summaryLabels = { udyam: 'Udyam', pan: 'PAN', acc: 'Bank document', fssai: 'FSSAI', gst: 'GST', otherDocs: 'Other documents', shopPhoto: 'Shop photo', ownerPhoto: 'Merchant photo' };
const summaryKeys = { udyam: 'udyam', pan: 'pan', acc: 'bank', fssai: 'fssai', shopPhoto: 'shopPhoto', ownerPhoto: 'ownerPhoto' };
state.saved = {};
state.edits = {};
state.excluded = new Set();
state.editing = null;
state.riskApproved = false;
let installPrompt;

function feedback(text = '') {
  $('feedback').textContent = text;
  $('feedback').hidden = !text;
}

async function api(path, data) {
  const form = data instanceof FormData;
  const headers = form ? {} : { 'Content-Type': 'application/json' };
  const response = await fetch('/api/' + path, { method: 'POST', headers, body: form ? data : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error([result.message, result.errors && JSON.stringify(result.errors)].filter(Boolean).join('\n')), { status: response.status });
  return result;
}

function needsDocumentExtraction() {
  return state.files.length > 0 && !state.approved;
}

function controls() {
  const extractingNext = needsDocumentExtraction();
  const send = $('send');
  send.textContent = state.approved && state.review ? 'Submit' : 'Continue';
  send.formNoValidate = extractingNext;
  $('consent-field').hidden = extractingNext;
  for (const button of document.querySelectorAll('button')) {
    button.disabled = state.busy || (button === send && (Boolean(state.editing) || state.needsRefresh));
  }
}

function loading(message) {
  const dialog = $('loading-indicator');
  $('loading-message').textContent = message;
  if (message && !dialog.open) dialog.showModal();
  if (!message && dialog.open) dialog.close();
}

$('loading-indicator').oncancel = event => event.preventDefault();

async function action(work, message = 'Please wait…') {
  if (state.busy) return;
  state.busy = true;
  controls();
  feedback();
  loading(message);
  let errorMessage;
  try { feedback(await work()); }
  catch (error) { errorMessage = error.message || 'Unable to complete the request.'; }
  finally { loading(''); state.busy = false; controls(); }
  if (errorMessage) {
    $('error-message').textContent = errorMessage;
    $('error-dialog').showModal();
  }
}

function item(parent, text) {
  const li = document.createElement('li');
  li.textContent = text;
  parent.append(li);
}

function onboardingComplete(result) {
  return ['ONBOARDED', 'ALREADY_ONBOARDED'].includes(result?.onboardingStatus);
}

function statusLabel(status) {
  return String(status || 'Unknown').toLowerCase().replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase());
}

function renderCompletion(result) {
  const receipt = $('completion-receipt');
  receipt.replaceChildren();
  for (const [label, value] of [
    ['Onboarding status', result.onboardingStatus],
    ['MSME ID', result.msmeId],
    ['ONDC status', result.ondcStatus],
    ['Message', result.message]
  ]) {
    if (value == null || value === '') continue;
    const row = document.createElement('div');
    const title = document.createElement('dt');
    const detail = document.createElement('dd');
    title.textContent = label;
    detail.textContent = String(value);
    row.append(title, detail);
    receipt.append(row);
  }

  const items = $('completion-items');
  items.replaceChildren();
  for (const [key, documentStatus] of Object.entries(result.documents)) {
    if (!documentStatus?.status) continue;
    const row = document.createElement('div');
    const title = document.createElement('dt');
    const detail = document.createElement('dd');
    const badge = document.createElement('span');
    title.textContent = Object.hasOwn(labels, key) ? labels[key] : fieldLabel(key);
    badge.className = 'completion-badge';
    if (['VERIFIED', 'RECEIVED'].includes(documentStatus.status)) badge.classList.add('complete');
    if (['REJECTED', 'UNREADABLE', 'FAILED'].includes(documentStatus.status)) badge.classList.add('issue');
    badge.textContent = statusLabel(documentStatus.status);
    detail.append(badge);
    if (documentStatus.reason) {
      const reason = document.createElement('p');
      reason.textContent = documentStatus.reason;
      detail.append(reason);
    }
    row.append(title, detail);
    items.append(row);
  }
}

function renderStatus() {
  const result = state.status;
  const allowed = allowedSections(result);
  const targets = documentKeys.filter(key => allowed.has(key));
  $('layout').dataset.stage = state.accepted ? 'documents' : 'consent';
  $('lookup').hidden = true;
  $('result').hidden = false;
  const complete = onboardingComplete(result);
  $('completion').hidden = !complete;
  $('documents').hidden = complete;
  if (complete) {
    $('layout').dataset.stage = 'complete';
    $('heading').textContent = 'Onboarding result';
    $('summary').textContent = '+91 ' + state.mobile;
    for (const id of ['pending', 'notes', 'collection', 'photos', 'submission', 'document-workspace']) $(id).hidden = true;
    renderCompletion(result);
    controls();
    return;
  }
  $('notes').hidden = false;
  $('heading').textContent = 'Onboarding dashboard';
  $('summary').textContent = ['+91 ' + state.mobile, result.onboardingStatus.replaceAll('_', ' '), result.msmeId && 'MSME ID ' + result.msmeId, result.ondcStatus && 'ONDC ' + result.ondcStatus].filter(Boolean).join(' · ');
  $('pending').textContent = ['NOT_ELIGIBLE', 'ALREADY_ONBOARDED'].includes(result.onboardingStatus) ? result.message || '' : '';
  $('pending').hidden = !$('pending').textContent;
  $('documents').replaceChildren();
  for (const [key, label] of Object.entries(labels)) {
    if (key === 'fssai' && !result.pending.includes('fssai')) continue;
    const value = result.documents[key]?.status;
    const completed = value === 'VERIFIED' || value === 'RECEIVED';
    const step = document.createElement('li');
    const dot = document.createElement('span');
    const name = document.createElement('strong');
    step.className = completed ? 'tracker-step done' : 'tracker-step';
    dot.className = 'tracker-dot';
    dot.textContent = completed ? '✓' : '•';
    dot.setAttribute('aria-hidden', 'true');
    name.textContent = label;
    step.append(dot, name);
    if (completed) {
      const status = document.createElement('small');
      status.textContent = value;
      step.append(status);
    }
    $('documents').append(step);
  }
  $('notes').replaceChildren();
  for (const note of [result.notes, result.uploadWarnings].flat().filter(Boolean)) item($('notes'), typeof note === 'string' ? note : JSON.stringify(note));
  if (hasRecordedConsent(result)) state.accepted = true;
  $('collection').hidden = state.accepted;
  $('layout').dataset.stage = state.accepted ? 'documents' : 'consent';
  $('submission').hidden = !state.accepted || !allowed.size;
  $('doc-upload').hidden = !state.accepted || !targets.length;
  renderStage();
}

function renderStage() {
  if (!state.status || onboardingComplete(state.status)) return;
  const allowed = allowedSections(state.status);
  $('shop-field').hidden = !allowed.has('shopPhoto');
  $('owner-field').hidden = !allowed.has('ownerPhoto');
  $('location-field').hidden = !allowed.has('location');
  $('photos').hidden = !state.accepted || ($('shop-field').hidden && $('location-field').hidden && $('owner-field').hidden);
  $('gps').textContent = state.location ? 'Update location' : 'Use current location';
  $('clear-location').hidden = !state.location;
  $('consent-items').replaceChildren();
  item($('consent-items'), 'Merchant mobile: +91 ' + state.mobile);
  if (state.approved && state.review) {
    for (const [key, type] of Object.entries(types)) {
      const data = reviewedBundle()[type];
      if (!data || !allowed.has(key)) continue;
      const values = Object.entries(data).filter(([field, value]) => field !== 'sourceFileIndexes' && value).map(([field, value]) => field + ': ' + value);
      item($('consent-items'), labels[key] + (values.length ? ' — ' + values.join(', ') : ''));
    }
  }
  if (state.shopPhoto) item($('consent-items'), 'Shop photo: ' + state.shopPhoto.name);
  if (state.ownerPhoto) item($('consent-items'), 'Merchant photo: ' + state.ownerPhoto.name);
  if (state.location) item($('consent-items'), 'Shop location: ' + coordinates(state.location));
  renderSummary();
  controls();
}

function coordinates(location) {
  return location.latitude.toFixed(6) + ', ' + location.longitude.toFixed(6);
}

function discardReview() {
  if (state.review) api('cancel-review', { mobile: state.mobile, token: state.review.token }).catch(() => {});
  state.review = null;
  state.approved = false;
  state.edits = {};
  state.excluded.clear();
  state.editing = null;
  state.riskApproved = false;
  $('consent').checked = false;
}

function photoIcon(label, path) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'photo-icon';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
  return button;
}

function preview(key, boxId) {
  const box = $(boxId);
  if (previews.has(key)) URL.revokeObjectURL(previews.get(key));
  previews.delete(key);
  box.replaceChildren();
  $(key === 'shopPhoto' ? 'shop-photo-options' : 'owner-photo-options').hidden = Boolean(state[key]);
  if (!state[key]) return;
  const img = document.createElement('img');
  img.src = URL.createObjectURL(state[key]);
  img.alt = labels[key];
  img.className = 'preview';
  previews.set(key, img.src);
  const actions = document.createElement('div');
  actions.className = 'photo-icon-actions';
  const retake = photoIcon('Retake ' + labels[key].toLowerCase(),
    '<path d="M3 12a9 9 0 1 1 2.7 6.4M3 7v5h5"/>');
  retake.onclick = () => openCamera(key);
  const remove = photoIcon('Delete ' + labels[key].toLowerCase(),
    '<path d="M3 6h18M9 6V3h6v3m4 0-1 15H6L5 6m5 4v7m4-7v7"/>');
  remove.onclick = () => {
    state[key] = null;
    $('consent').checked = false;
    preview(key, boxId);
    renderStage();
  };
  actions.append(retake, remove);
  box.append(img, actions);
}

function resetUploads() {
  state.files = [];
  state.shopPhoto = state.ownerPhoto = state.location = null;
  renderLocationDetails();
  $('consent').checked = false;
  preview('shopPhoto', 'shop-preview');
  preview('ownerPhoto', 'owner-preview');
}

function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('theme-toggle').setAttribute('aria-checked', String(dark));
  document.querySelector('meta[name="theme-color"]').content = dark ? '#18271f' : '#173e32';
}

let savedTheme;
try { savedTheme = localStorage.getItem('imoo-theme'); } catch {}
applyTheme(savedTheme);
$('theme-toggle').onclick = () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(theme);
  try { localStorage.setItem('imoo-theme', theme); } catch {}
};

$('back-to-mobile').onclick = () => {
  if (state.busy) return;
  discardReview();
  resetUploads();
  state.mobile = '';
  state.status = null;
  state.saved = {};
  state.accepted = false;
  state.needsRefresh = false;
  for (const url of summaryUrls.splice(0)) URL.revokeObjectURL(url);
  for (const id of ['document-summary', 'completion-receipt', 'completion-items', 'documents', 'consent-items', 'notes']) $(id).replaceChildren();
  for (const id of ['summary', 'pending']) $(id).textContent = '';
  $('mobile').value = '';
  $('layout').dataset.stage = 'mobile';
  $('result').hidden = true;
  $('lookup').hidden = false;
  feedback();
  $('mobile').focus();
};

$('lookup').onsubmit = event => {
  event.preventDefault();
  action(async () => {
    const mobile = $('mobile').value.trim();
    state.status = await api('status', { mobile });
    state.mobile = mobile;
    renderStatus();
  }, 'Checking onboarding status…');
};
$('refresh').onclick = () => action(async () => {
  state.status = await api('status', { mobile: state.mobile });
  state.needsRefresh = false;
  renderStatus();
}, 'Refreshing status…');
$('agree').onclick = () => { state.accepted = true; renderStatus(); };
for (const button of document.querySelectorAll('[data-pick]')) button.onclick = () => $(button.dataset.pick).click();
function addDocuments(selected) {
  if (!selected.length) return;
  const next = [...state.files, ...selected];
  if (next.length > 8 || next.reduce((bytes, file) => bytes + file.size, 0) > 12 * 1024 * 1024) {
    feedback('Choose up to eight documents totalling at most 12 MB.');
    return;
  }
  discardReview();
  state.files = next;
  renderStage();
  feedback();
}

$('all').onchange = event => {
  const selected = [...event.target.files];
  event.target.value = '';
  addDocuments(selected);
};

function reviewedBundle() {
  const bundle = { ...(state.review?.extraction || {}) };
  for (const [type, fields] of Object.entries(state.edits)) bundle[type] = { ...bundle[type], ...fields };
  for (const type of state.excluded) delete bundle[type];
  return bundle;
}

const fieldLabels = {
  panNo: 'PAN number', udyamNo: 'Udyam number', gstNumber: 'GSTIN', ifsc: 'IFSC',
  dob: 'Date of birth', fatherName: 'Father Name', bankName: 'Bank Name', accountNumber: 'Account Number', number: 'Licence number', expiryDate: 'Expiry date', nicCode: 'NIC code',
  accountHolderName: 'Account holder', mobile: 'Mobile number'
};
function fieldLabel(key) {
  return fieldLabels[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, letter => letter.toUpperCase());
}

function displayValue(key, value) {
  if (['dob', 'expiryDate'].includes(key) && /^\d{4}-\d{2}-\d{2}$/.test(value || '')) return value.split('-').reverse().join('/');
  return value;
}

function appendFields(container, fields, order) {
  const entries = order ? order.map(key => [key, fields[key]]) : Object.entries(fields);
  for (const [key, value] of entries) {
    if (['sourceFileIndexes', 'imageUrl', 'photo', 'status', 'reason'].includes(key) || (!order && (value == null || value === ''))) continue;
    if (value && typeof value === 'object') {
      if (!Array.isArray(value)) appendFields(container, value);
      continue;
    }
    const label = document.createElement('dt');
    const detail = document.createElement('dd');
    label.textContent = fieldLabel(key);
    detail.textContent = displayValue(key, value) || '—';
    const row = document.createElement('div');
    row.append(label, detail);
    container.append(row);
  }
}

function addSummaryImage(container, file, title) {
  if (!file?.type.startsWith('image/')) return;
  const image = document.createElement('img');
  image.src = URL.createObjectURL(file);
  summaryUrls.push(image.src);
  image.alt = title;
  container.append(image);
}

function deleteDraftDocument(type) {
  state.excluded.add(type);
  delete state.edits[type];
  state.editing = null;
  state.riskApproved = false;
  $('consent').checked = false;
  renderStage();
}

function renderSummary() {
  for (const url of summaryUrls.splice(0)) URL.revokeObjectURL(url);
  const grid = $('document-summary');
  grid.replaceChildren();
  const draft = reviewedBundle();
  for (const [type, title] of Object.entries(summaryLabels)) {
    const status = state.status.documents[summaryKeys[type]];
    const saved = state.saved[type];
    if (type === 'shopPhoto' || type === 'ownerPhoto') continue;
    const extracted = draft[type];
    const local = Boolean(extracted && (type !== 'otherDocs' || Object.keys(extracted).length));
    const backendData = status?.data || status?.details;
    const data = local ? extracted : saved?.data || backendData;
    const remotePhoto = status?.imageUrl || backendData?.imageUrl || backendData?.photo;
    const hasFields = data && Object.entries(data).some(([key, value]) =>
      !['sourceFileIndexes', 'imageUrl', 'photo', 'status', 'reason'].includes(key)
      && value != null && value !== '');
    if (!local && !hasFields && !saved?.file && !remotePhoto) continue;
    const card = document.createElement('section');
    card.className = 'summary-card';
    const head = document.createElement('div');
    const heading = document.createElement('h3');
    heading.textContent = title;
    head.className = 'row';
    head.append(heading);
    const canEdit = local && Object.hasOwn(extractionFields, type);
    if (local && state.editing !== type) {
      const actions = document.createElement('div');
      actions.className = 'card-actions';
      if (canEdit) {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = 'Edit';
      edit.setAttribute('aria-label', 'Edit ' + title);
      edit.onclick = () => { state.editing = type; renderSummary(); controls(); };
        actions.append(edit);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Delete';
      remove.setAttribute('aria-label', 'Delete ' + title + ' from this upload');
      remove.onclick = () => deleteDraftDocument(type);
      actions.append(remove);
      head.append(actions);
    }
    const body = document.createElement('div');
    body.className = 'summary-body';
    const thumb = local ? state.files[extracted.sourceFileIndexes?.[0]] : saved?.file;
    if (thumb?.type.startsWith('image/')) {
      addSummaryImage(body, thumb, title + ' preview');
    } else if (remotePhoto) {
      try {
        const url = new URL(remotePhoto);
        if (url.protocol === 'https:') {
          const image = document.createElement('img');
          image.src = url.href;
          image.alt = title + ' preview';
          image.referrerPolicy = 'no-referrer';
          body.append(image);
        }
      } catch {}
    }
    const content = document.createElement('div');
    content.className = 'summary-content';
    if (state.editing === type && canEdit) {
      const inputs = new Map();
      for (const key of reviewFields[type]) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        label.textContent = fieldLabel(key);
        input.value = displayValue(key, data[key]) || '';
        input.maxLength = 500;
        input.readOnly = !editableFields(type).includes(key);
        if (!input.readOnly) inputs.set(key, input);
        label.append(input);
        content.append(label);
      }
      const save = document.createElement('button');
      const cancel = document.createElement('button');
      save.type = cancel.type = 'button';
      save.textContent = 'Save';
      cancel.textContent = 'Cancel';
      save.onclick = () => {
        state.edits[type] = Object.fromEntries([...inputs].map(([key, input]) => [key, input.value.trim()]));
        state.editing = null;
        state.riskApproved = false;
        $('consent').checked = false;
        renderStage();
      };
      cancel.onclick = () => { state.editing = null; renderStage(); };
      content.append(save, cancel);
    } else if (data) {
      const details = document.createElement('dl');
      appendFields(details, data, reviewFields[type]);
      if (details.childElementCount) content.append(details);
      else content.textContent = 'No readable details.';
    } else {
      const empty = document.createElement('p');
      empty.textContent = 'No extracted details available.';
      content.append(empty);
    }
    body.append(content);
    card.append(head, body);
    grid.append(card);
  }
  const selected = state.review ? state.review.unclassified : state.files.map((_, index) => index);
  for (const index of selected) {
    const file = state.files[index];
    if (!file) continue;
    const card = document.createElement('section');
    card.className = 'summary-card selected-file';
    const body = document.createElement('div');
    body.className = 'summary-body';
    addSummaryImage(body, file, 'Selected document');
    const name = document.createElement('p');
    name.textContent = file.name;
    body.append(name);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Delete';
    remove.setAttribute('aria-label', 'Delete ' + file.name);
    remove.onclick = () => {
      if (state.review) {
        state.review.unclassified = state.review.unclassified.filter(source => source !== index);
      } else {
        state.files.splice(index, 1);
      }
      renderStage();
    };
    card.append(body, remove);
    grid.append(card);
  }
  grid.hidden = !grid.childElementCount;
  $('document-workspace').hidden = $('doc-upload').hidden && grid.hidden;
}

function currentNameMatch() {
  return compareNames(reviewedBundle(), savedPanName(state.status) || state.saved.pan?.data?.name);
}

function openReview() {
  const match = currentNameMatch();
  $('review-message').textContent = 'Some document names differ from the PAN name. Confirm that the documents belong to this merchant. A business name may differ from the owner’s name.';
  $('accept-review').textContent = 'Continue with risk';
  const list = document.createElement('ul');
  for (const entry of match.documents) item(list, entry.document + ': ' + entry.name + (entry.document === 'PAN' ? ' (reference)' : ''));
  $('review-details').replaceChildren(list);
  $('review-dialog').showModal();
}

function closeReview() {
  $('review-dialog').close();
}
function extractDocuments() {
  return action(async () => {
    discardReview();
    const form = new FormData();
    form.set('mobile', state.mobile);
    form.set('accepted', String(state.accepted));
    for (const file of state.files) form.append('documents', file);
    if (state.files.length > 1) {
      loading('Combining documents…');
      form.set('collage', await combineDocuments(state.files));
    }
    loading('Reading documents…');
    state.review = await api('extract', form);
    state.approved = true;
    renderStage();
    $('document-summary').scrollIntoView({ block: 'nearest' });
    return state.review.unclassified.length ? 'Some files could not be identified. Check the document summary.' : '';
  }, 'Reading documents…');
}
$('cancel-review').onclick = closeReview;
$('review-dialog').oncancel = event => { event.preventDefault(); $('cancel-review').click(); };
$('accept-review').onclick = () => {
  closeReview();
  state.riskApproved = true;
  submitItems();
};

async function locate() {
  if (!window.isSecureContext || !navigator.geolocation) throw Error('Location capture needs HTTPS or localhost.');
  const result = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject,
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }));
  return { latitude: result.coords.latitude, longitude: result.coords.longitude };
}
function renderLocationDetails() {
  const location = state.location;
  $('location-details').hidden = !location;
  $('shop-latitude').textContent = location ? location.latitude.toFixed(6) : '';
  $('shop-longitude').textContent = location ? location.longitude.toFixed(6) : '';
  $('coordinates').textContent = location ? 'Location captured' : '';
}

function showLocation() {
  renderLocationDetails();
  $('consent').checked = false;
  renderStage();
}
async function savePhoto(key, file) {
  if (file.size > 10 * 1024 * 1024) throw Error('Choose a photo up to 10 MB.');
  state[key] = file;
  preview(key, key === 'shopPhoto' ? 'shop-preview' : 'owner-preview');
  if (key === 'shopPhoto' && allowedSections(state.status).has('location')) {
    state.location = null;
    showLocation();
    loading('Getting your shop location…');
    try { state.location = await locate(); }
    catch { return 'Shop photo added. Use current location to attach the shop location.'; }
  }
  showLocation();
}

const cameraDialog = $('shop-camera-dialog');
const cameraVideo = $('shop-camera-preview');
const cameraCapture = $('shop-camera-capture');
let cameraStream;
let cameraRequest = 0;
let cameraTarget;

function closeCamera() {
  cameraRequest++;
  cameraStream?.getTracks().forEach(track => track.stop());
  cameraStream = undefined;
  cameraTarget = undefined;
  cameraVideo.srcObject = null;
  if (cameraDialog.open) cameraDialog.close();
}

async function openCamera(key) {
  if (state.busy || cameraDialog.open) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    feedback('Photo capture needs camera access over HTTPS or localhost.');
    return;
  }
  const request = ++cameraRequest;
  cameraTarget = key;
  $('camera-heading').textContent = key === 'document' ? 'Capture document' : labels[key];
  cameraCapture.disabled = true;
  $('shop-camera-status').textContent = 'Opening camera…';
  cameraDialog.showModal();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: key === 'ownerPhoto' ? 'user' : 'environment' } }, audio: false });
    if (request !== cameraRequest) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    cameraStream = stream;
    cameraVideo.srcObject = stream;
    await cameraVideo.play();
    if (request === cameraRequest) {
      cameraCapture.disabled = false;
      $('shop-camera-status').textContent = '';
    }
  } catch {
    if (request !== cameraRequest) return;
    $('shop-camera-status').textContent = 'Could not open the camera. Check your camera permission and try again.';
  }
}
$('document-camera').onclick = () => openCamera('document');
$('shop-camera').onclick = () => openCamera('shopPhoto');
$('owner-camera').onclick = () => openCamera('ownerPhoto');
$('shop-camera-close').onclick = closeCamera;
cameraDialog.oncancel = event => { event.preventDefault(); closeCamera(); };
cameraCapture.onclick = async () => {
  if (!cameraVideo.videoWidth || cameraCapture.disabled) return;
  cameraCapture.disabled = true;
  const request = cameraRequest;
  const canvas = document.createElement('canvas');
  canvas.width = cameraVideo.videoWidth;
  canvas.height = cameraVideo.videoHeight;
  canvas.getContext('2d').drawImage(cameraVideo, 0, 0);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (request !== cameraRequest) return;
  if (!blob) {
    cameraCapture.disabled = false;
    $('shop-camera-status').textContent = 'Could not capture the photo. Try again.';
    return;
  }
  const key = cameraTarget;
  closeCamera();
  if (key === 'document') {
    addDocuments([new File([blob], 'document-' + (state.files.length + 1) + '.jpg', { type: 'image/jpeg' })]);
    return;
  }
  const photo = new File([blob], key === 'shopPhoto' ? 'shop-photo.jpg' : 'merchant-photo.jpg', { type: 'image/jpeg' });
  action(() => savePhoto(key, photo), 'Saving ' + labels[key].toLowerCase() + '…');
};

$('owner').onchange = event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (file) action(() => savePhoto('ownerPhoto', file), 'Preparing merchant photo…');
};
$('gps').onclick = () => action(async () => {
  state.location = await locate();
  showLocation();
}, 'Getting your shop location…');

$('clear-location').onclick = () => {
  state.location = null;
  showLocation();
};

function submitItems() {
  if (onboardingComplete(state.status)) return;
  const useReview = state.approved && Boolean(state.review);
  if (state.busy || state.needsRefresh || state.editing || (state.files.length && !useReview)) return;
  if (!$('consent').reportValidity()) return;
  if (useReview && currentNameMatch().requiresRisk && !state.riskApproved) { openReview(); return; }
  action(async () => {
    const form = new FormData();
    const allowed = allowedSections(state.status);
    const bundle = reviewedBundle();
    form.set('mobile', state.mobile);
    form.set('accepted', String(state.accepted));
    if (useReview) {
      form.set('reviewToken', state.review.token);
      form.set('acceptRisk', String(state.riskApproved));
      form.set('edits', JSON.stringify(state.edits));
      form.set('excludedTypes', JSON.stringify([...state.excluded]));
    }
    for (const key of ['shopPhoto', 'ownerPhoto']) {
      if (state[key] && allowed.has(key)) form.set(key, state[key]);
    }
    if (state.location && allowed.has('location')) {
      for (const [key, value] of Object.entries(state.location)) form.set(key, value);
    }
    form.set('consent', 'true');
    try {
      state.status = await api('submit', form);
      const sent = new Set(state.status.submittedSections || []);
      for (const [type, key] of Object.entries(summaryKeys)) {
        if (!sent.has(key)) continue;
        const data = bundle[type];
        const file = data ? state.files[data.sourceFileIndexes?.[0]] : state[type];
        state.saved[type] = { data: data || (file ? { file: file.name } : null), file };
      }
      for (const type of ['gst', 'otherDocs']) {
        const data = bundle[type];
        if (data && Object.keys(data).length) state.saved[type] = { data, file: state.files[data.sourceFileIndexes?.[0]] };
      }
      state.review = null;
      discardReview();
      resetUploads();
      renderStatus();
    } catch (error) {
      if (useReview && error.status === 409) { discardReview(); renderStage(); }
      if (!error.status || error.status === 429 || error.status >= 500) state.needsRefresh = true;
      throw error;
    }
  }, 'Submitting for verification…');
}

$('submission').onsubmit = event => {
  event.preventDefault();
  if (state.busy || state.needsRefresh || onboardingComplete(state.status)) return;
  if (needsDocumentExtraction()) extractDocuments();
  else submitItems();
};

window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('install').hidden = false; });
$('install').onclick = async () => { await installPrompt?.prompt(); installPrompt = null; $('install').hidden = true; };
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
