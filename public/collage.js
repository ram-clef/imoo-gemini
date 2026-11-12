const maxPages = 12;
const tileWidth = 1440;
const tileHeight = 1900;
const gutter = 24;
const header = 66;

async function renderPdf(file, remaining) {
  const pdfjs = await import('/pdf.mjs').catch(() => {
    throw Error('PDF collage support needs npm install. You can also upload screenshots of the PDF pages.');
  });
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs';
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false,
    useSystemFonts: true, useWasm: false, disableFontFace: true }).promise;
  const pages = [];
  try {
    if (pdf.numPages > remaining) throw Error('A combined upload can contain up to ' + maxPages + ' images and PDF pages.');
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const size = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(tileWidth / size.width, tileHeight / size.height) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
      pages.push(canvas);
      page.cleanup();
    }
    return pages;
  } finally {
    await pdf.destroy();
  }
}

export async function combineDocuments(files) {
  const tiles = [];
  let canvas;
  try {
    for (const [index, file] of files.entries()) {
      if (tiles.length >= maxPages) throw Error('A combined upload can contain up to ' + maxPages + ' images and PDF pages.');
      if (file.type === 'application/pdf') {
        const pages = await renderPdf(file, maxPages - tiles.length);
        pages.forEach((image, page) => tiles.push({ image, index, page: page + 1 }));
      } else {
        const image = await createImageBitmap(file).catch(() => {
          throw Error('Could not open ' + file.name + '. Save it as a JPG or PNG and try again.');
        });
        tiles.push({ image, index });
      }
    }
    const columns = 2;
    const rows = Math.ceil(tiles.length / columns);
    const rowHeights = Array.from({ length: rows }, (_, row) => Math.max(...tiles.slice(row * columns, (row + 1) * columns)
      .map(({ image }) => Math.ceil(image.height * Math.min(1, tileWidth / image.width, tileHeight / image.height)))) + header + gutter);
    const offsets = rowHeights.map((_, row) => rowHeights.slice(0, row).reduce((sum, height) => sum + height, gutter));
    const width = columns * (tileWidth + gutter) + gutter;
    const height = rowHeights.reduce((sum, value) => sum + value, gutter);
    const scale = Math.min(1, 8192 / height, Math.sqrt(24000000 / (width * height)));
    canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(0, 0, width, height);
    for (const [position, { image, index, page }] of tiles.entries()) {
      const row = Math.floor(position / columns);
      const x = gutter + position % columns * (tileWidth + gutter);
      const y = offsets[row];
      ctx.fillStyle = '#fff';
      ctx.fillRect(x, y, tileWidth, rowHeights[row] - gutter);
      ctx.fillStyle = '#111';
      ctx.font = 'bold 36px sans-serif';
      ctx.fillText('Source ' + (index + 1) + (page ? ' / page ' + page : ''), x + 12, y + 46);
      const ratio = Math.min(1, tileWidth / image.width, tileHeight / image.height);
      ctx.drawImage(image, x, y + header, image.width * ratio, image.height * ratio);
    }
    for (const quality of [0.94, 0.82, 0.68]) {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size <= 10 * 1024 * 1024) return new File([blob], 'combined-documents.jpg', { type: 'image/jpeg' });
    }
    throw Error('The combined image is too large. Select fewer pages and try again.');
  } finally {
    for (const { image } of tiles) {
      if (typeof image.close === 'function') image.close();
      else image.width = image.height = 0;
    }
    if (canvas) canvas.width = canvas.height = 0;
  }
}
