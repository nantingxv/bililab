"""登录态管理：DPAPI 加密存储 + 扫码登录 + 手动粘贴。"""
import base64
import ctypes
import json
import os
import time
import urllib.parse
import urllib.request
from ctypes import wintypes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, "config.json")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0")


# ---------------- DPAPI ----------------
class _BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


_C32 = ctypes.WinDLL("crypt32", use_last_error=True)
_K32 = ctypes.WinDLL("kernel32", use_last_error=True)
_C32.CryptProtectData.argtypes = [ctypes.POINTER(_BLOB), wintypes.LPCWSTR, ctypes.POINTER(_BLOB),
                                  ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_BLOB)]
_C32.CryptProtectData.restype = wintypes.BOOL
_C32.CryptUnprotectData.argtypes = [ctypes.POINTER(_BLOB), ctypes.c_void_p, ctypes.POINTER(_BLOB),
                                    ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_BLOB)]
_C32.CryptUnprotectData.restype = wintypes.BOOL


def _to_blob(data):
    buf = ctypes.create_string_buffer(data, len(data))
    return _BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))), buf


def dpapi_protect(data: bytes) -> bytes:
    bin_, _keep = _to_blob(data)
    out = _BLOB()
    if not _C32.CryptProtectData(ctypes.byref(bin_), None, None, None, None, 0, ctypes.byref(out)):
        raise OSError("CryptProtectData failed: %d" % ctypes.get_last_error())
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        _K32.LocalFree(out.pbData)


def dpapi_unprotect(data: bytes) -> bytes:
    bin_, _keep = _to_blob(data)
    out = _BLOB()
    if not _C32.CryptUnprotectData(ctypes.byref(bin_), None, None, None, None, 0, ctypes.byref(out)):
        raise OSError("CryptUnprotectData failed: %d" % ctypes.get_last_error())
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        _K32.LocalFree(out.pbData)


# ---------------- config ----------------
_DEFAULT = {"cookies_enc": None, "buvid": {}, "session": {}, "last_snapshot": None}


def load_config():
    if not os.path.exists(CONFIG):
        return dict(_DEFAULT)
    try:
        with open(CONFIG, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        return dict(_DEFAULT)
    for k, v in _DEFAULT.items():
        cfg.setdefault(k, v)
    return cfg


def save_config(cfg):
    tmp = CONFIG + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=1)
    os.replace(tmp, CONFIG)


def set_cookies(cfg, cookies: dict):
    raw = json.dumps(cookies, ensure_ascii=False).encode("utf-8")
    cfg["cookies_enc"] = base64.b64encode(dpapi_protect(raw)).decode("ascii")
    save_config(cfg)


def get_cookies(cfg) -> dict:
    enc = cfg.get("cookies_enc")
    if not enc:
        return {}
    try:
        return json.loads(dpapi_unprotect(base64.b64decode(enc)).decode("utf-8"))
    except Exception:
        return {}


def cookie_header(cookies: dict) -> str:
    return "; ".join("%s=%s" % (k, v) for k, v in cookies.items() if v)


# ---------------- 登录 ----------------
def _get(url, headers=None):
    h = {"User-Agent": UA, "Accept": "application/json, text/plain, */*",
         "Accept-Language": "zh-CN,zh;q=0.9", "Referer": "https://www.bilibili.com/"}
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode("utf-8", "replace")), r.headers


def ensure_buvid(cfg) -> dict:
    b = cfg.get("buvid") or {}
    if b.get("buvid3"):
        return b
    d, _ = _get("https://api.bilibili.com/x/frontend/finger/spi")
    b = {"buvid3": d["data"]["b_3"], "buvid4": d["data"]["b_4"]}
    cfg["buvid"] = b
    save_config(cfg)
    return b


def qr_generate():
    d, _ = _get("https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header")
    if d.get("code") != 0:
        raise RuntimeError(d.get("message") or "二维码生成失败")
    return d["data"]["url"], d["data"]["qrcode_key"]


def qr_poll(key):
    """返回 (state, cookies)。state: 0 成功 / 86101 待扫 / 86090 已扫待确认 / 86038 失效"""
    d, headers = _get("https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=%s&source=main-fe-header"
                      % urllib.parse.quote(key))
    data = d.get("data") or {}
    state = data.get("code", -1)
    cookies = {}
    if state == 0:
        for sc in headers.get_all("Set-Cookie") or []:
            kv = sc.split(";", 1)[0]
            if "=" in kv:
                k, v = kv.split("=", 1)
                cookies[k.strip()] = v.strip()
    return state, cookies


def validate(cfg, cookies=None):
    """用 /nav 校验登录态，成功则写入 session 与 cookie。"""
    cookies = cookies or get_cookies(cfg)
    if not cookies:
        return None
    b = ensure_buvid(cfg)
    jar = dict(cookies)
    jar.setdefault("buvid3", b.get("buvid3", ""))
    jar.setdefault("buvid4", b.get("buvid4", ""))
    try:
        d, _ = _get("https://api.bilibili.com/x/web-interface/nav",
                    {"Cookie": cookie_header(jar), "Referer": "https://www.bilibili.com/"})
    except Exception:
        return None
    if d.get("code") != 0 or not (d.get("data") or {}).get("isLogin"):
        return None
    data = d["data"]
    cfg["session"] = {"mid": data["mid"], "uname": data.get("uname"), "face": data.get("face"),
                      "level": (data.get("level_info") or {}).get("current_level")}
    set_cookies(cfg, jar)
    return cfg["session"]


def login_paste(cfg, raw):
    """接受整段 Cookie 字符串，或单独的 SESSDATA。"""
    raw = (raw or "").strip()
    jar = {}
    if "=" in raw and ";" in raw:
        for part in raw.split(";"):
            if "=" in part:
                k, v = part.split("=", 1)
                jar[k.strip()] = v.strip()
    elif raw:
        jar["SESSDATA"] = raw
    if "SESSDATA" not in jar:
        raise RuntimeError("没有找到 SESSDATA")
    b = ensure_buvid(cfg)
    jar.setdefault("buvid3", b.get("buvid3", ""))
    jar.setdefault("buvid4", b.get("buvid4", ""))
    if "DedeUserID" not in jar:
        mid = jar["SESSDATA"].split("%2C")[0]
        if mid.isdigit():
            jar["DedeUserID"] = mid
    sess = validate(cfg, jar)
    if not sess:
        raise RuntimeError("SESSDATA 无效或已过期")
    return sess
