# RVC 输出的落地处理。单独成模块是因为 rvc_python 的 vc_single 返回值形状不止一种：
# 有的模型给 ndarray，有的给 (ndarray, 采样率)，还有的给 ((ndarray, ...), 采样率)。
# 之前按"元组第二个元素一定是采样率"硬转 int，遇到嵌套元组就 TypeError，整条变声失败。
import os

import numpy as np
import soundfile as sf


def _find_array(obj):
    if isinstance(obj, np.ndarray):
        return obj
    if isinstance(obj, (list, tuple)):
        for item in obj:
            found = _find_array(item)
            if found is not None:
                return found
    return None


def pick_audio_and_sr(result, default_sr):
    """从 vc_single 的返回值里剥出音频数组和采样率；剥不出来就报错，不许悄悄写静音。"""
    audio = _find_array(result)
    if audio is None:
        raise RuntimeError("没从返回值里找到音频数组（类型 %s）" % type(result).__name__)
    sr = default_sr
    if isinstance(result, (list, tuple)) and len(result) >= 2:
        last = result[-1]
        if isinstance(last, (int, float, np.integer, np.floating)) and not isinstance(last, bool):
            sr = int(last)
    return np.asarray(audio), int(sr)


def write_output(path, audio, sr):
    """int16 必须按整数写：转成 float 再写会被当成 -1..1 归一化，超出部分全部削顶，
    听起来就是卡住的广播（实测 RMS 0.994、99% 采样削顶）。"""
    if audio.ndim > 1:
        audio = audio.reshape(-1)
    if np.issubdtype(audio.dtype, np.integer):
        sf.write(path, audio, sr)
    else:
        sf.write(path, audio.astype(np.float32), sr)
    size = os.path.getsize(path)
    if size < 2048:
        raise RuntimeError("输出只有 %d 字节" % size)
    return size
