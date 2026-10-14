const status = document.querySelector('#chat-status');
const result = document.querySelector('#copy-result');
const selected = document.querySelector('#selected-context');
const prompt = document.querySelector('#prompt');

function announceCopy(reply) {
  result.textContent = reply.copied ? `Copiado al portapapeles (${reply.characters} caracteres).` : 'No se pudo copiar.';
}

document.querySelector('#copy-selection').addEventListener('click', async () => {
  const start = selected.selectionStart;
  const end = selected.selectionEnd;
  const value = start !== end ? selected.value.slice(start, end) : selected.value;
  try { announceCopy(await window.a3Demo.copyText(value)); }
  catch { result.textContent = 'No se pudo copiar la selección.'; }
});

document.querySelector('#copy-prompt').addEventListener('click', async () => {
  try { announceCopy(await window.a3Demo.copyText(prompt.value)); }
  catch { result.textContent = 'No se pudo copiar el prompt.'; }
});

document.querySelector('#retry').addEventListener('click', () => window.a3Demo.retryChat());
document.querySelector('#back').addEventListener('click', () => window.a3Demo.history('back'));
document.querySelector('#forward').addEventListener('click', () => window.a3Demo.history('forward'));
document.querySelector('#open-external').addEventListener('click', async () => {
  try {
    await window.a3Demo.openExternal();
    document.querySelector('#external-offer').hidden = true;
  } catch { status.textContent = 'No se pudo abrir el enlace externo.'; }
});

window.a3Demo.onStatus(({ status: state, detail = '' }) => {
  const labels = { loading: 'Cargando ChatGPT…', ready: 'ChatGPT cargado', error: `Error: ${detail}`, blocked: detail };
  status.dataset.state = state;
  status.textContent = labels[state] || 'Estado desconocido';
  if (state === 'error' || state === 'blocked') document.querySelector('#retry').hidden = state === 'blocked';
});

window.a3Demo.onExternalLink(({ url }) => {
  document.querySelector('#external-label').textContent = `Enlace externo: ${url}`;
  document.querySelector('#external-offer').hidden = false;
});

window.a3Demo.onNavigation(({ canGoBack, canGoForward }) => {
  document.querySelector('#back').disabled = !canGoBack;
  document.querySelector('#forward').disabled = !canGoForward;
});
