// Backend selection. One env var, one import.
//
// Adding a backend is: write a module exporting { name, describe, load }, add a
// line here. Nothing else in the service changes, and no caller is affected.
//
// Registered by name rather than by dynamic path so that an unknown
// INFERENCE_BACKEND fails at startup with the list of real options, instead of
// failing later with a module-not-found that reads like a broken install.

import { env } from '../config.js';
import * as onnx from './onnx.js';

const BACKENDS = new Map([
  [onnx.name, onnx],
  // Expected next, in rough order of likelihood:
  //   ['triton',  await import('./triton.js')]   an existing GPU server over HTTP
  //   ['vllm',    await import('./vllm.js')]     if embeddings move to a served runtime
  // A CUDA machine does NOT need a new backend. The onnx one takes
  // INFERENCE_DEVICE=cuda and transformers.js passes it to ONNX Runtime.
]);

export function selectBackend() {
  const b = BACKENDS.get(env.backend);
  if (!b) {
    throw new Error(
      `INFERENCE_BACKEND='${env.backend}' is not a backend. Available: `
      + `${[...BACKENDS.keys()].join(', ')}. `
      + 'For an NVIDIA GPU keep INFERENCE_BACKEND=onnx and set INFERENCE_DEVICE=cuda.');
  }
  return b;
}

export { BACKENDS };
