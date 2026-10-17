import { parentPort, workerData } from 'node:worker_threads';
import { convertImage, imageEngineInfo, inspectImage } from './image-codec';

async function run(): Promise<void> {
  try {
    const result = workerData.action === 'inspect'
      ? { source: await inspectImage(workerData.bytes), engine: imageEngineInfo() }
      : await convertImage(workerData.bytes, workerData.settings);
    parentPort!.postMessage({ ok: true, result });
  } catch (error) { parentPort!.postMessage({ ok: false, message: error instanceof Error ? error.message : 'No se pudo procesar la imagen.' }); }
}
void run();
