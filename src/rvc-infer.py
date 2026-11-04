#!/usr/bin/env python
# RVC 二次变声的一次性工人：读一个音频、过一个音色模型、写一个 wav，然后退出。
# 只做这一件事：不常驻、不监听端口、不碰项目外的目录；失败就把原因打成一行 JSON 给上层。
#
# 为什么不直接用 rvc_python 自带的 infer_file：那个封装在新版 torch 上会把
# vc_single 的返回值原样塞给 scipy.wavfile.write（返回 tuple 时直接崩），而且默认
# weights_only=True 会拒掉带 fairseq Dictionary 的检查点。这里自己调底层并处理两种返回形状。
import argparse
import json
import os
import sys
import tempfile
import time


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="音色模型 .pth 的绝对路径")
    ap.add_argument("--index", default="", help="配套 .index，可空")
    ap.add_argument("--src", required=True, help="输入音频（mp3 或 wav）")
    ap.add_argument("--dst", required=True, help="输出 wav")
    ap.add_argument("--transpose", type=int, default=0, help="音高偏移（半音）")
    ap.add_argument("--index-rate", type=float, default=0.5)
    ap.add_argument("--f0", default="harvest", help="harvest/pm/crepe/rmvpe/mfcc")
    ap.add_argument("--protect", type=float, default=0.33)
    args = ap.parse_args()

    started = time.time()
    tmp = ""
    try:
        import numpy as np
        import soundfile as sf
        import torch
        import librosa
        from fairseq.data.dictionary import Dictionary
        from rvc_python.infer import RVCInference

        # 检查点里存了 fairseq 的 Dictionary；torch 2.6 起默认拒收，这里只放行这一个类。
        torch.serialization.add_safe_globals([Dictionary])

        y, sr = librosa.load(args.src, sr=None, mono=True)
        tmp = os.path.join(tempfile.gettempdir(), "bizhi-rvc-%d.wav" % os.getpid())
        sf.write(tmp, y, sr)

        rvc = RVCInference(models_dir=os.path.dirname(os.path.abspath(args.model)), device="cpu:0")
        rvc.load_model(os.path.abspath(args.model), version="v2", index_path=args.index or "")

        result = rvc.vc.vc_single(
            sid=0,
            input_audio_path=tmp,
            f0_up_key=int(args.transpose),
            f0_method=args.f0,
            file_index=args.index or "",
            index_rate=float(args.index_rate),
            filter_radius=3,
            resample_sr=0,
            rms_mix_rate=1,
            protect=float(args.protect),
            f0_file="",
            file_index2="",
        )
        # 有的版本返回 (音频, 采样率)，有的直接返回音频数组。
        if isinstance(result, tuple):
            audio = result[0]
            out_sr = int(result[1]) if len(result) > 1 and result[1] else int(rvc.vc.tgt_sr)
        else:
            audio = result
            out_sr = int(rvc.vc.tgt_sr)
        audio = np.asarray(audio, dtype=np.float32)
        if audio.ndim > 1:
            audio = audio.reshape(-1)
        sf.write(args.dst, audio, out_sr)

        size = os.path.getsize(args.dst)
        if size < 2048:
            raise RuntimeError("输出只有 %d 字节，当失败处理" % size)
        print(json.dumps({
            "ok": True,
            "bytes": size,
            "srcSr": int(sr),
            "outSr": out_sr,
            "seconds": round(time.time() - started, 2),
            "audioSeconds": round(len(audio) / out_sr, 2),
        }, ensure_ascii=False))
        return 0
    except Exception as error:  # noqa: BLE001 - 任何一层炸了都要变成一行可读的 JSON
        print(json.dumps({"ok": False, "error": "%s: %s" % (type(error).__name__, str(error)[:220])}, ensure_ascii=False))
        return 1
    finally:
        if tmp and os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())
