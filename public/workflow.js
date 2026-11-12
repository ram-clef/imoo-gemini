export const documentKeys = ['udyam', 'pan', 'bank', 'fssai'];
export const completeStatuses = new Set(['VERIFIED', 'RECEIVED', 'NOT_REQUIRED']);

export function hasRecordedConsent(status) {
  return ['RECEIVED', 'VERIFIED'].includes(status?.documents?.consent?.status);
}


export function isFresh(status) {
  if (status.onboardingStatus !== 'IN_PROGRESS' || status.msmeId) return false;
  if (documentKeys.slice(0, 3).some(key => status.documents[key]?.status !== 'PENDING')) return false;
  return Object.entries(status.documents).every(([key, item]) =>
    ['PENDING', 'NOT_REQUIRED'].includes(item?.status) || (key === 'fssai' && item?.status === 'WAITING'));
}

export function allowedSections(status) {
  const keys = new Set(status.pending);
  const ownerPhoto = status.documents.ownerPhoto;
  if (completeStatuses.has(ownerPhoto?.status)) {
    keys.delete('ownerPhoto');
  } else if (ownerPhoto && ['IN_PROGRESS', 'ONBOARDED', 'ALREADY_ONBOARDED'].includes(status.onboardingStatus)) {
    keys.add('ownerPhoto');
  }
  if (isFresh(status)) {
    if (status.documents.fssai?.status === 'WAITING') keys.add('fssai');
  }
  return keys;
}

export const extractionFields = {
  pan: ['name', 'panNo', 'fatherName', 'dob'],
  udyam: ['udyamNo', 'name', 'shopName', 'proprietorName', 'mobile', 'category', 'address', 'pincode', 'email', 'nicCode'],
  acc: ['accountHolderName', 'bankName', 'accountNumber', 'ifsc', 'branch'],
  fssai: ['name', 'number', 'expiryDate'],
  gst: ['name', 'gstNumber', 'tradeName', 'address']
};

export const reviewFields = {
  ...extractionFields,
  udyam: ['udyamNo', 'name', 'mobile', 'email', 'pincode', 'shopName']
};

export function editableFields(type) {
  return (reviewFields[type] || []).filter(key => type !== 'fssai' || key !== 'expiryDate');
}

export function savedPanName(status) {
  const pan = status?.documents?.pan;
  return [pan?.data?.name, pan?.details?.name, pan?.name].find(value => typeof value === 'string' && value.trim());
}

export function compareNames(bundle, savedPan) {
  const pan = bundle.pan?.name || savedPan;
  const names = Object.entries({
    PAN: pan, Udyam: bundle.udyam?.name || bundle.udyam?.proprietorName,
    Bank: bundle.acc?.accountHolderName, FSSAI: bundle.fssai?.name, GST: bundle.gst?.name
  }).filter(([, name]) => typeof name === 'string' && name.trim());
  const normalize = name => name.normalize('NFKD').toUpperCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).sort().join(' ');
  function similarity(left, right) {
    const a = normalize(left), b = normalize(right);
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + Number(a[i - 1] !== b[j - 1]));
      row = next;
    }
    return Math.round(100 * (1 - row[b.length] / Math.max(a.length, b.length, 1)));
  }
  const documents = names.map(([document, name]) => ({
    document, name, score: pan && document !== 'PAN' ? similarity(pan, name) : null
  }));
  return { documents, requiresRisk: Boolean(pan && names.some(([document, name]) => document !== 'PAN' && normalize(pan) !== normalize(name))) };
}
