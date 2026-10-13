import os
import re

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from hsemotion_onnx.facial_emotions import HSEmotionRecognizer
from pydantic import BaseModel
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

app = FastAPI(title="Revela AI service")

# ---------------------------------------------------------------- models (loaded once)
recognizer = HSEmotionRecognizer(model_name="enet_b0_8_va_mtl")  # face -> emotions + valence/arousal
vader = SentimentIntensityAnalyzer()  # text -> valence (English)
EMOTIONS = ["anger", "contempt", "disgust", "fear", "happiness", "neutral", "sadness", "surprise"]
_whisper = {"model": None, "failed": False}


def load_face_detector():
    """Haar face detector if this OpenCV build has it; otherwise None."""
    try:
        detector = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        if not detector.empty():
            return detector
    except Exception as e:
        print("Haar detector unavailable:", e)
    return None


face_detector = load_face_detector()
print(f"OpenCV {cv2.__version__} | face detector: {'haar' if face_detector is not None else 'center-crop fallback'}")


def clip(x, lo=-1.0, hi=1.0):
    return float(np.clip(x, lo, hi))


def read_expression(face_bgr):
    """A cropped face -> (valence, arousal, emotion probabilities)."""
    _, s = recognizer.predict_emotions(cv2.cvtColor(face_bgr, cv2.COLOR_BGR2RGB), logits=False)
    probs = {n: round(float(p), 3) for n, p in zip(EMOTIONS, s[:8])}
    return clip(s[8]), clip(s[9]), probs


def largest_face(img):
    if face_detector is None:
        return None
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    faces = face_detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(40, 40))
    if len(faces) == 0:
        return None
    x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
    return img[y:y + h, x:x + w]


# ---------------------------------------------------------------- live viewer frame
@app.get("/health")
def health():
    return {"ok": True, "detector": "haar" if face_detector is not None else "center-crop"}


@app.post("/analyze")
async def analyze(frame: UploadFile = File(...)):
    """One camera frame -> the viewer's facial expression as valence/arousal (-1..1)."""
    img = cv2.imdecode(np.frombuffer(await frame.read(), np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return {"face": False, "reason": "bad_image"}

    if face_detector is not None:
        face = largest_face(img)
        if face is None:
            return {"face": False, "reason": "no_face"}
    else:  # selfie assumption: face is near the middle
        H, W = img.shape[:2]
        s = min(H, W)
        face = img[(H - s) // 2:(H - s) // 2 + s, (W - s) // 2:(W - s) // 2 + s]

    v, a, probs = read_expression(face)
    return {"face": True, "valence": round(v, 3), "arousal": round(a, 3), "emotions": probs, "top": max(probs, key=probs.get)}


# ---------------------------------------------------------------- reel analysis
def video_signals(path):
    """Faces in the video, motion (editing pace / movement), and color mood."""
    out = {}
    cap = cv2.VideoCapture(path)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    if total <= 0:
        cap.release()
        return out
    duration = total / fps
    out["duration"] = round(duration, 1)

    # 1) facial expressions of people in the reel (~1 sample per second, 3..12 samples)
    n = int(min(12, max(3, duration)))
    vs, as_, tops, brightness, saturation = [], [], [], [], []
    for idx in np.linspace(0, total - 1, n).astype(int):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(idx))
        ok, frame = cap.read()
        if not ok:
            continue
        frame = cv2.resize(frame, (480, int(frame.shape[0] * 480 / frame.shape[1])))
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        brightness.append(float(hsv[..., 2].mean()))
        saturation.append(float(hsv[..., 1].mean()))
        face = largest_face(frame)
        if face is not None:
            v, a, probs = read_expression(face)
            vs.append(v)
            as_.append(a)
            tops.append(max(probs, key=probs.get))
    if vs:
        frac = len(vs) / max(1, len(brightness))
        out["faces"] = {"v": float(np.mean(vs)), "a": float(np.mean(as_)), "conf": 0.9 * frac, "seen": tops[:6]}

    # 2) motion: difference between frames 0.15 s apart, at 8 places in the video
    diffs, gap = [], max(1, int(fps * 0.15))
    for pos in np.linspace(0, max(0, total - gap - 2), 8).astype(int):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(pos))
        ok1, f1 = cap.read()
        for _ in range(gap - 1):
            cap.grab()
        ok2, f2 = cap.read()
        if ok1 and ok2:
            g1 = cv2.cvtColor(cv2.resize(f1, (160, 160)), cv2.COLOR_BGR2GRAY).astype(np.float32)
            g2 = cv2.cvtColor(cv2.resize(f2, (160, 160)), cv2.COLOR_BGR2GRAY).astype(np.float32)
            diffs.append(float(np.abs(g1 - g2).mean()))
    if diffs:
        m = float(np.mean(diffs))
        out["motion"] = {"a": float(np.interp(m, [1.0, 18.0], [-0.5, 0.6])), "conf": 0.4, "raw": round(m, 2)}

    # 3) color: bright + saturated reads happier than dark + dull (weak signal)
    if brightness:
        b, s = float(np.mean(brightness)), float(np.mean(saturation))
        out["color"] = {"v": clip((b - 110) / 110 * 0.4 + (s - 80) / 100 * 0.3), "conf": 0.12}
    cap.release()
    return out


def load_audio(path, sr=16000):
    """Decode a video's audio track to mono float32 at 16 kHz (uses PyAV, which ships its own ffmpeg)."""
    import av

    container = av.open(path)
    try:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            return None
        resampler = av.AudioResampler(format="s16", layout="mono", rate=sr)
        chunks = []
        for frame in list(container.decode(stream)) + [None]:  # None flushes the resampler
            out = resampler.resample(frame)
            for rf in (out if isinstance(out, list) else [out]):
                if rf is not None:
                    chunks.append(rf.to_ndarray().reshape(-1))
    finally:
        container.close()
    return np.concatenate(chunks).astype(np.float32) / 32768.0 if chunks else None


def audio_signals(path):
    """Loudness (arousal) and, if the model is available, speech -> text -> valence."""
    out = {}
    try:
        audio = load_audio(path)
    except Exception as e:
        print("[audio] could not read audio:", e)
        return out
    if audio is None or audio.size < 8000:
        return out

    win = 8000  # 0.5 s windows
    rms = [np.sqrt(np.mean(audio[i:i + win] ** 2)) for i in range(0, audio.size - win, win)]
    db = 20 * np.log10(np.array(rms) + 1e-9)
    loud = float(np.percentile(db, 75))
    if np.percentile(db, 90) > -55:  # not silent
        out["audio"] = {"a": float(np.interp(loud, [-45, -12], [-0.7, 0.7])), "conf": 0.5, "db": round(loud, 1)}

    text = transcribe(audio[: 16000 * 60])
    if text:
        words = re.findall(r"\w+", text)
        out["speech"] = {"v": vader.polarity_scores(text)["compound"], "conf": 0.6 * min(1.0, len(words) / 15), "text": text[:300]}
    return out


def transcribe(audio):
    if _whisper["failed"]:
        return ""
    try:
        if _whisper["model"] is None:
            from faster_whisper import WhisperModel
            _whisper["model"] = WhisperModel("tiny", device="cpu", compute_type="int8")
        segments, _ = _whisper["model"].transcribe(audio, beam_size=1, vad_filter=True)
        return " ".join(s.text.strip() for s in segments).strip()
    except Exception as e:
        _whisper["failed"] = True  # restart the service to retry
        print("[speech] speech-to-text unavailable:", e)
        return ""


def fuse(parts):
    """Confidence-weighted average of every signal that has a value for an axis."""
    res = {}
    for axis, key in (("valence", "v"), ("arousal", "a")):
        num = den = 0.0
        for p in parts.values():
            if p.get(key) is not None and p.get("conf", 0) > 0:
                num += p[key] * p["conf"]
                den += p["conf"]
        res[axis] = round(clip(num / den), 3) if den > 0 else 0.0
        res[axis + "_conf"] = round(den, 2)
    return res


class ReelRequest(BaseModel):
    path: str
    caption: str = ""


@app.post("/analyze-reel")
def analyze_reel(req: ReelRequest):
    """Whole reel -> mood (valence/arousal) from faces, speech, caption, audio energy, motion and color.
    The path is read from disk, so this only works while the backend and this service run on the same computer."""
    if not os.path.isfile(req.path):
        raise HTTPException(404, "video file not found")

    parts = {}
    for name, fn in (("video", lambda: video_signals(req.path)), ("audio", lambda: audio_signals(req.path))):
        try:
            parts.update(fn())
        except Exception as e:
            print(f"[{name}] failed:", e)

    caption = (req.caption or "").strip()
    if caption:
        words = re.findall(r"\w+", caption)
        parts["caption"] = {"v": vader.polarity_scores(caption)["compound"], "conf": 0.5 * min(1.0, len(words) / 6)}

    parts.pop("duration", None)
    fused = fuse({k: v for k, v in parts.items() if isinstance(v, dict)})
    return {
        "valence": fused["valence"],
        "arousal": fused["arousal"],
        "confidence": {"valence": fused["valence_conf"], "arousal": fused["arousal_conf"]},
        "signals": {k: {kk: (round(vv, 3) if isinstance(vv, float) else vv) for kk, vv in v.items()} for k, v in parts.items() if isinstance(v, dict)},
        "transcript": parts.get("speech", {}).get("text", ""),
    }