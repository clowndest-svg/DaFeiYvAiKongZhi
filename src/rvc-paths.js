// RVC 相关路径只在这里算一次：引擎、工人脚本、模型目录、清单、基座权重。
// 单独成模块是为了让 rvc.js 和 rvc-runner.js 都能引用而不互相绕成循环依赖。
import path from 'node:path';
import { paths } from './config.js';

export function rvcPaths(root = paths.root) {
  const base = String(root || paths.root);
  return {
    root: base,
    python: path.join(base, 'voice', 'rvc-env', 'Scripts', 'python.exe'),
    worker: path.join(base, 'src', 'rvc-infer.py'),
    server: path.join(base, 'src', 'rvc-server.py'),
    modelDir: path.join(base, 'voice', 'rvc', 'models'),
    manifest: path.join(base, 'voice', 'rvc', 'models', 'manifest.json'),
    baseWeights: path.join(base, 'voice', 'rvc-env', 'Lib', 'site-packages', 'rvc_python', 'base_model', 'hubert_base.pt'),
  };
}
