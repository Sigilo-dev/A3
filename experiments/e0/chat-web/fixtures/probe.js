window.probeFinished = true;
window.tryProjectFile = async (url) => {
  const request = fetch(url).then((response) => response.text()).then(() => true).catch(() => false);
  return Promise.race([request, new Promise((resolve) => setTimeout(() => resolve(false), 1200))]);
};
