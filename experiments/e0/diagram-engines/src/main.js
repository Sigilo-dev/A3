import mermaid from 'mermaid';

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });

const cases = [
  { name: 'mermaid-c4-context', path: '/fixtures/mermaid/c4-context.mmd' },
  { name: 'mermaid-class-model', path: '/fixtures/mermaid/class-model.mmd' },
];
const status = document.querySelector('#status');
const diagrams = document.querySelector('#diagrams');

async function saveArtifact(name, svg) {
  const response = await fetch('/__artifact', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, svg }),
  });
  if (!response.ok) throw new Error(`artifact save failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function renderAll() {
  status.textContent = 'Running…';
  diagrams.replaceChildren();
  const results = [];
  try {
    for (const item of cases) {
      const source = await (await fetch(item.path, { cache: 'no-store' })).text();
      const syntax = await mermaid.parse(source);
      const { svg, bindFunctions } = await mermaid.render(`${item.name}-svg`, source);
      const section = document.createElement('article');
      section.innerHTML = `<h2>${item.name}</h2><p>Parser type: ${syntax.diagramType}</p><div class="diagram">${svg}</div>`;
      diagrams.append(section);
      bindFunctions?.(section);
      const saved = await saveArtifact(item.name, svg);
      results.push({ name: item.name, type: syntax.diagramType, svgBytes: new TextEncoder().encode(svg).length, saved });
    }
    status.textContent = JSON.stringify({ ok: true, mermaid: '12.2.0', results }, null, 2);
  } catch (error) {
    status.textContent = JSON.stringify({ ok: false, error: String(error?.stack ?? error) }, null, 2);
  }
}

document.querySelector('#render').addEventListener('click', renderAll);
await renderAll();
