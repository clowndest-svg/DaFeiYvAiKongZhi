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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

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
    from rvc_audio import pick_audio_and_sr  # noqa: F401  (与 convert 共用同一套形状处理)
    started = time.time()
    pth = os.path.abspath(str(task.get("model") or ""))
    index = os.path.abspath(str(task.get("index") or "")) if task.get("index") else ""
    if not pth or not os.path.isfile(pth):
        return {"ok": False, "error": "模型文件不在：%s" % os.path.basename(pth)[:60]}
    if STATE["pth"] == pth and STATE["index"] == index:
        return {"ok": True, "loaded": STATE["loaded"], "ms": 0, "cached": True}
    rvc = ensure_engine()
    # 换模型之前先把上一个从内存里丢掉：连着载入第三个会把机器吃干
    # （实测 OpenBLAS malloc failed / 0xC0000005，整个工人进程直接没了）。
    if STATE["loaded"] and STATE["pth"] != pth:
        try:
            import gc
            rvc.vc.model_infos.clear()
            rvc.vc.net_g = None
            gc.collect()
        except Exception:
            pass
    rvc.load_model(pth, version="v2", index_path=index)
    STATE["pth"] = pth
    STATE["index"] = index
    STATE["loaded"] = os.path.basename(pth)
    return {"ok": True, "loaded": STATE["loaded"], "ms": round((time.time() - started) * 1000)}


def do_convert(task):
    import librosa
    import soundfile as sf
    from rvc_audio import pick_audio_and_sr, write_output

    src = str(task.get("src") or "")
    dst = str(task.get("dst") or "")
    if not os.path.isfile(src):
        return {"ok": False, "error": "要变声的音频不在"}
    if not STATE["rvc"] or not STATE["loaded"]:
        return {"ok": False, "error": "还没载入音色模型"}
    started = time.time()
    rvc = STATE["rvc"]
    # 上游可能给 mp3：vc_single 内部按路径读，先统一解成 wav 再交给它。
    path_in = src
    if not src.lower().endswith(".wav"):
        y, sr = librosa.load(src, sr=None, mono=True)
        path_in = os.path.join(os.environ.get("TEMP", tempfile_dir()), "bizhi-rvc-in-%d.wav" % os.getpid())
        sf.write(path_in, y, sr)
    result = rvc.vc.vc_single(
        sid=0,
        input_audio_path=path_in,
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
    audio, out_sr = pick_audio_and_sr(result, rvc.vc.tgt_sr)
    size = write_output(dst, audio, out_sr)
    if path_in != src:
        try:
            os.remove(path_in)
        except OSError:
            pass
    return {
        "ok": True,
        "bytes": size,
        "outSr": out_sr,
        "ms": round((time.time() - started) * 1000),
        "loaded": STATE["loaded"],
        "audioSeconds": round(len(audio.reshape(-1)) / out_sr, 2),
    }


def tempfile_dir():
    import tempfile
    return tempfile.gettempdir()


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
