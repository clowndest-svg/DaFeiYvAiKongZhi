#!/usr/bin/env python
# RVC 常驻工人：从 stdin 一行一个 JSON 任务，转好的 wav 写到指定路径，结果一行 JSON 回给上层。
#
# 为什么要常驻：本机 CPU 上第一次转换要 20 秒以上（torch 冷启动 + hubert 首次前向），
# 同一个进程里第二次只要 6 秒。他选的是"以后发语音都用这个声音"，每条都冷启动一次太慢。
# 空闲时间到了由上层把整个进程收掉，不在这里自己常驻不退。
import json
import os
import sys
import time

STATE = {"rvc": None, "loaded": "", "pth": "", "index": ""}


def send(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def ensure_engine():
    if STATE["rvc"] is not None:
        return STATE["rvc"]
    import torch
    from fairseq.data.dictionary import Dictionary
    from rvc_python.infer import RVCInference

    # 检查点里存了 fairseq 的 Dictionary；torch 2.6 起默认拒收，这里只放行这一个类。
    torch.serialization.add_safe_globals([Dictionary])
    models_dir = os.environ.get("BIZHI_RVC_MODELS_DIR") or "."
    STATE["rvc"] = RVCInference(models_dir=models_dir, device="cpu:0")
    return STATE["rvc"]


def do_load(task):
    started = time.time()
    pth = os.path.abspath(str(task.get("model") or ""))
    index = os.path.abspath(str(task.get("index") or "")) if task.get("index") else ""
    if not pth or not os.path.isfile(pth):
        return {"ok": False, "error": "模型文件不在：%s" % os.path.basename(pth)[:60]}
    if STATE["pth"] == pth and STATE["index"] == index:
        return {"ok": True, "loaded": STATE["loaded"], "ms": 0, "cached": True}
    rvc = ensure_engine()
    rvc.load_model(pth, version="v2", index_path=index)
    STATE["pth"] = pth
    STATE["index"] = index
    STATE["loaded"] = os.path.basename(pth)
    return {"ok": True, "loaded": STATE["loaded"], "ms": round((time.time() - started) * 1000)}


def do_convert(task):
    import numpy as np
    import soundfile as sf
    import librosa

    src = str(task.get("src") or "")
    dst = str(task.get("dst") or "")
    if not os.path.isfile(src):
        return {"ok": False, "error": "要变声的音频不在"}
    if not STATE["rvc"] or not STATE["loaded"]:
        return {"ok": False, "error": "还没载入音色模型"}
    started = time.time()
    y, sr = librosa.load(src, sr=None, mono=True)
    rvc = STATE["rvc"]
    result = rvc.vc.vc_single(
        sid=0,
        input_audio_path=src if src.lower().endswith(".wav") else write_tmp(y, sr),
        f0_up_key=int(task.get("transpose") or 0),
        f0_method=str(task.get("f0") or "harvest"),
        file_index=STATE["index"],
        index_rate=float(task.get("index_rate", 0.5)),
        filter_radius=3,
        resample_sr=0,
        rms_mix_rate=1,
        protect=float(task.get("protect", 0.33)),
        f0_file="",
        file_index2="",
    )
    if isinstance(result, tuple):
        audio = result[0]
        out_sr = int(result[1]) if len(result) > 1 and result[1] else int(rvc.vc.tgt_sr)
    else:
        audio = result
        out_sr = int(rvc.vc.tgt_sr)
    audio = np.asarray(audio, dtype=np.float32).reshape(-1)
    sf.write(dst, audio, out_sr)
    size = os.path.getsize(dst)
    if size < 2048:
        return {"ok": False, "error": "输出只有 %d 字节" % size}
    return {"ok": True, "bytes": size, "outSr": out_sr, "ms": round((time.time() - started) * 1000), "loaded": STATE["loaded"]}


def write_tmp(y, sr):
    import soundfile as sf
    import tempfile
    path = os.path.join(tempfile.gettempdir(), "bizhi-rvc-tmp-%d.wav" % os.getpid())
    sf.write(path, y, sr)
    return path


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            task = json.loads(line)
        except ValueError:
            send({"ok": False, "error": "任务不是 JSON"})
            continue
        cmd = str(task.get("cmd") or "")
        try:
            if cmd == "exit":
                send({"ok": True, "bye": True})
                return 0
            if cmd == "status":
                send({"ok": True, "loaded": STATE["loaded"], "pid": os.getpid()})
                continue
            if cmd == "load":
                send(do_load(task))
                continue
            if cmd == "convert":
                send(do_convert(task))
                continue
            send({"ok": False, "error": "不认识的任务：%s" % cmd[:30]})
        except Exception as error:  # noqa: BLE001 - 单条任务炸了不该带走整个工人
            send({"ok": False, "error": "%s: %s" % (type(error).__name__, str(error)[:200])})
    return 0


if __name__ == "__main__":
    sys.exit(main())
