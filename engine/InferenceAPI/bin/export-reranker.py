"""Export BAAI/bge-reranker-v2-m3 to ONNX for the Inference API.

The cross-encoder §6.1 specifies ships no ONNX build on the Hub (OPEN-ITEMS
§7), so it is converted here with Hugging Face Optimum and written where the
service resolves local models (config.js localModelPath):

    models/bge-reranker-v2-m3/
        config.json, tokenizer.json, tokenizer_config.json, ...
        onnx/model.onnx        fp32, ~2.2 GB (kept for CPU and for re-conversion)
        onnx/model_fp16.onnx   fp16, ~1.1 GB (what the GPU serves)

Run from engine/InferenceAPI with the export venv active:

    python bin/export-reranker.py [--repo BAAI/bge-reranker-v2-m3] [--out models/bge-reranker-v2-m3]

Then in .env:  RERANK_MODEL_REPO=bge-reranker-v2-m3  RERANK_MODEL_ID=bge-reranker-v2-m3@onnx-fp16

fp16 conversion keeps the inputs and outputs float32-compatible for
onnxruntime's DirectML provider; a handful of ops that are numerically unsafe in
half precision are left in fp32 by the converter's block list.
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', default='BAAI/bge-reranker-v2-m3')
    ap.add_argument('--out', default='models/bge-reranker-v2-m3')
    ap.add_argument('--skip-fp16', action='store_true')
    args = ap.parse_args()

    out = Path(args.out)
    tmp = out.parent / (out.name + '.export')
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)

    # 1. fp32 ONNX via Optimum's exporter (sequence classification head, one logit).
    cmd = [sys.executable, '-m', 'optimum.exporters.onnx', '--model', args.repo,
           '--task', 'text-classification', '--opset', '17', str(tmp)]
    print('+', ' '.join(cmd), flush=True)
    subprocess.run(cmd, check=True)

    # 2. Lay out the way transformers.js expects: tokenizer files at the root,
    #    weights under onnx/.
    onnx_dir = out / 'onnx'
    if out.exists():
        shutil.rmtree(out)
    onnx_dir.mkdir(parents=True)
    for f in tmp.iterdir():
        if f.suffix == '.onnx' or f.name.endswith('.onnx_data'):
            shutil.move(str(f), str(onnx_dir / ('model.onnx' if f.suffix == '.onnx' else 'model.onnx_data')))
        else:
            shutil.move(str(f), str(out / f.name))
    shutil.rmtree(tmp, ignore_errors=True)

    # transformers.js reads `transformers.js_config` if present; nothing needed
    # for a plain sequence-classification model.

    if not args.skip_fp16:
        # 3. fp16. onnxconverter-common keeps io types float32 by default
        #    (keep_io_types=True), which is what the JS tokenizer feeds.
        import onnx
        from onnxconverter_common import float16
        model = onnx.load(str(onnx_dir / 'model.onnx'), load_external_data=True)
        model16 = float16.convert_float_to_float16(model, keep_io_types=True)
        onnx.save(model16, str(onnx_dir / 'model_fp16.onnx'))
        print('wrote', onnx_dir / 'model_fp16.onnx', flush=True)

    print('done:', sorted(p.name for p in out.iterdir()), '/', sorted(p.name for p in onnx_dir.iterdir()))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
