import { getStroke } from 'perfect-freehand';

function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, (character) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
  })[character]);
}

function polygonPath(points) {
  if (!points.length) return '';
  return `M ${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(' L ')} Z`;
}

function strokePolygon(stroke) {
  const points = stroke.points.map(({ x, y, pressure = 0.5 }) => [x, y, pressure]);
  return getStroke(points, {
    size: stroke.size ?? 8,
    thinning: 0.5,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: false
  });
}

export function buildSvg(snapshot, options = {}) {
  const width = options.width ?? 960;
  const height = options.height ?? 560;
  const padding = options.padding ?? 28;
  const nodes = snapshot.nodes ?? [];
  const edges = snapshot.edges ?? [];
  const drawings = snapshot.drawings ?? [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const bounds = [];

  for (const node of nodes) {
    const nodeWidth = Number(node.data?.width ?? 170);
    const nodeHeight = Number(node.data?.height ?? 72);
    bounds.push({ minX: node.position.x, minY: node.position.y, maxX: node.position.x + nodeWidth, maxY: node.position.y + nodeHeight });
  }
  for (const drawing of drawings) {
    const points = strokePolygon(drawing);
    if (points.length) {
      bounds.push({
        minX: Math.min(...points.map(([x]) => x)),
        minY: Math.min(...points.map(([, y]) => y)),
        maxX: Math.max(...points.map(([x]) => x)),
        maxY: Math.max(...points.map(([, y]) => y))
      });
    }
  }

  const minX = bounds.length ? Math.min(...bounds.map((box) => box.minX)) : 0;
  const minY = bounds.length ? Math.min(...bounds.map((box) => box.minY)) : 0;
  const maxX = bounds.length ? Math.max(...bounds.map((box) => box.maxX)) : width;
  const maxY = bounds.length ? Math.max(...bounds.map((box) => box.maxY)) : height;
  const contentWidth = maxX - minX;
  const contentHeight = maxY - minY;
  const viewBox = `${(minX - padding).toFixed(2)} ${(minY - padding).toFixed(2)} ${(contentWidth + padding * 2).toFixed(2)} ${(contentHeight + padding * 2).toFixed(2)}`;
  const elements = [];

  for (const edge of edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) continue;
    const sourceWidth = Number(source.data?.width ?? 170);
    const sourceHeight = Number(source.data?.height ?? 72);
    const targetHeight = Number(target.data?.height ?? 72);
    const x1 = source.position.x + sourceWidth;
    const y1 = source.position.y + sourceHeight / 2;
    const x2 = target.position.x;
    const y2 = target.position.y + targetHeight / 2;
    const middle = (x1 + x2) / 2;
    elements.push(`<path data-kind="visual-edge" d="M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}" fill="none" stroke="#475569" stroke-width="2"/>`);
  }

  for (const drawing of drawings) {
    elements.push(`<path data-kind="drawing" d="${polygonPath(strokePolygon(drawing))}" fill="${escapeXml(drawing.color ?? '#e11d48')}" stroke="none"/>`);
  }

  for (const node of nodes) {
    const nodeWidth = Number(node.data?.width ?? 170);
    const nodeHeight = Number(node.data?.height ?? 72);
    const label = escapeXml(node.data?.label ?? node.id);
    elements.push(`<g data-kind="node" data-node-id="${escapeXml(node.id)}"><rect x="${node.position.x}" y="${node.position.y}" width="${nodeWidth}" height="${nodeHeight}" rx="8" fill="#ffffff" stroke="#334155" stroke-width="2"/><text x="${node.position.x + 14}" y="${node.position.y + 43}" fill="#0f172a" font-family="Arial, sans-serif" font-size="16">${label}</text></g>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}" role="img" aria-label="A3 E0-D1 export fixture"><rect width="100%" height="100%" fill="#f8fafc"/>${elements.join('')}</svg>`;
}

export async function rasterizeSvg(svg, scale = 2) {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const width = Math.round(image.naturalWidth * scale);
    const height = Math.round(image.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, width, height);
    const png = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('canvas PNG encoding failed')), 'image/png'));
    return { blob: png, width, height, mimeType: png.type };
  } finally {
    URL.revokeObjectURL(url);
  }
}
