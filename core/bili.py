"""B 站 API 客户端：keep-alive 连接复用 + 全局令牌桶限速 + 多线程安全 + 风控自适应降速。"""
import gzip
import hashlib
import http.client
import json
import os
import ssl
import threading
import time
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WBI_CACHE = os.path.join(ROOT, "data", "wbi.json")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0")

MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
         33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
         26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
         20, 34, 44, 52]

RETRY_CODES = {-352, -412, -799, -509, -503, -404, 412, 429, 500, 502, 503}
SOFT_RETRY = {412, -412, 429}
SSL_CTX = ssl.create_default_context()


class BiliError(Exception):
    def __init__(self, code, msg):
        self.code = code
        super().__init__("code=%s %s" % (code, msg))


class RateLimiter:
    """全局令牌桶：所有线程共享一个节奏，而不是各自 sleep。"""

    def __init__(self, rate):
        self.rate = max(1.0, min(3.0, float(rate)))   # 起步保守，靠 ramp 爬升
        self.max_rate = float(rate)
        self.lock = threading.Lock()
        self.next_at = time.time()
        self.last_ramp = time.time()

    def acquire(self):
        with self.lock:
            now = time.time()
            if self.rate < self.max_rate and now - self.last_ramp > 15:
                self.rate = min(self.max_rate, self.rate * 1.12)
                self.last_ramp = now
            if self.next_at < now:
                self.next_at = now
            self.next_at += 1.0 / self.rate
            delay = self.next_at - now
        if delay > 0:
            time.sleep(delay)

    def slow(self):
        with self.lock:
            self.rate = max(1.0, self.rate * 0.5)
            self.last_ramp = time.time() + 60      # 惩罚后 1 分钟不再爬升
            self.next_at = time.time() + 2.5

    def speed_up(self):
        pass

    def current(self):
        with self.lock:
            return round(self.rate, 1)


class Client:
    """view 与 space 两个接口族的风控等级不同，分别限速。"""

    def __init__(self, cookies, rate=10.0, space_rate=2.0):
        self.cookies = dict(cookies)
        self.cookie_header = "; ".join("%s=%s" % (k, v) for k, v in cookies.items() if v)
        self.lim_view = RateLimiter(rate)
        self.lim_space = RateLimiter(space_rate)
        self.local = threading.local()
        self.lock = threading.Lock()
        self.stats = {"ok": 0, "fail": 0, "retry": 0}
        self._wbi = None
        self._wbi_lock = threading.Lock()
        self.cool_until = 0.0          # 全局冷却：被风控时所有线程一起停
        self.hits412 = 0

    def _cool(self, seconds):
        with self.lock:
            self.cool_until = max(self.cool_until, time.time() + seconds)

    def _wait_cool(self):
        while True:
            with self.lock:
                left = self.cool_until - time.time()
            if left <= 0:
                return
            time.sleep(min(3.0, max(0.05, left)))

    def _lim(self, tier):
        return self.lim_space if tier == "space" else self.lim_view

    # ---- connection ----
    def _conn(self):
        c = getattr(self.local, "c", None)
        if c is None:
            c = http.client.HTTPSConnection("api.bilibili.com", timeout=30, context=SSL_CTX)
            self.local.c = c
        return c

    def _drop(self):
        c = getattr(self.local, "c", None)
        if c is not None:
            try:
                c.close()
            except Exception:
                pass
        self.local.c = None

    @staticmethod
    def _path(url):
        u = urllib.parse.urlparse(url)
        return u.path + (("?" + u.query) if u.query else "")

    def _raw(self, url, referer, tier):
        self._wait_cool()
        self._lim(tier).acquire()
        conn = self._conn()
        conn.request("GET", self._path(url), headers={
            "User-Agent": UA, "Cookie": self.cookie_header, "Referer": referer,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Origin": "https://space.bilibili.com",
            "Accept-Encoding": "gzip", "Connection": "keep-alive"})
        r = conn.getresponse()
        body = r.read()
        status = r.status
        enc = r.getheader("Content-Encoding")
        if r.will_close:
            self._drop()
        if status != 200:
            raise BiliError(status, "HTTP")
        if enc == "gzip":
            body = gzip.decompress(body)
        return json.loads(body.decode("utf-8", "replace"))

    def get(self, url, referer="https://space.bilibili.com/", retries=5, tier="view"):
        last = None
        for attempt in range(retries):
            try:
                d = self._raw(url, referer, tier)
                if d.get("code") != 0:
                    raise BiliError(d.get("code"), d.get("message", ""))
                with self.lock:
                    self.stats["ok"] += 1
                self._lim(tier).speed_up()
                return d
            except BiliError as e:
                if e.code not in RETRY_CODES:
                    with self.lock:
                        self.stats["fail"] += 1
                    raise
                last = e
                self._lim(tier).slow()
                if e.code in SOFT_RETRY:          # 412 是风控惩罚：全局冷却，别各线程乱撞
                    with self.lock:
                        self.hits412 += 1
                        n = self.hits412
                    self._wbi = None
                    self._cool(min(600, 45 * n))
                else:
                    time.sleep(1.5 * (attempt + 1))
            except Exception as e:  # 连接层错误：丢弃连接重来
                last = e
                self._drop()
                time.sleep(0.8 + attempt)
            with self.lock:
                self.stats["retry"] += 1
        with self.lock:
            self.stats["fail"] += 1
        raise BiliError(-1, "重试失败: %s" % last)

    # ---- wbi ----
    def _load_wbi(self):
        today = time.strftime("%Y%m%d")
        try:
            with open(WBI_CACHE, "r", encoding="utf-8") as f:
                c = json.load(f)
            if c.get("date") == today and c.get("img") and c.get("sub"):
                return c["img"], c["sub"]
        except Exception:
            pass
        d = self.get("https://api.bilibili.com/x/web-interface/nav", "https://www.bilibili.com/")
        wk = (d.get("data") or {}).get("wbi_img") or {}
        img = wk["img_url"].rsplit("/", 1)[-1].split(".")[0]
        sub = wk["sub_url"].rsplit("/", 1)[-1].split(".")[0]
        try:
            with open(WBI_CACHE, "w", encoding="utf-8") as f:
                json.dump({"date": today, "img": img, "sub": sub}, f)
        except Exception:
            pass
        return img, sub

    def sign(self, params):
        if not self._wbi:
            with self._wbi_lock:
                if not self._wbi:
                    self._wbi = self._load_wbi()
        img, sub = self._wbi
        mixin = "".join((img + sub)[i] for i in MIXIN)[:32]
        p = dict(params)
        p["wts"] = int(time.time())
        q = urllib.parse.urlencode(sorted(p.items()))
        p["w_rid"] = hashlib.md5((q + mixin).encode()).hexdigest()
        return urllib.parse.urlencode(sorted(p.items()))

    # ---- endpoints ----
    def nav(self):
        return self.get("https://api.bilibili.com/x/web-interface/nav", "https://www.bilibili.com/",
                        tier="space")["data"]

    def tags(self, mid):
        return self.get("https://api.bilibili.com/x/relation/tags?vmid=%d" % mid, tier="space")["data"]

    def followings(self, mid, pn=1, ps=50):
        return self.get("https://api.bilibili.com/x/relation/followings?vmid=%d&pn=%d&ps=%d&order=desc"
                        % (mid, pn, ps), tier="space")["data"]

    def stat(self, mid):
        return self.get("https://api.bilibili.com/x/relation/stat?vmid=%d" % mid,
                        "https://www.bilibili.com/", tier="space")["data"]

    def arc_search(self, mid, pn=1, ps=50):
        q = self.sign({"mid": mid, "ps": ps, "pn": pn, "order": "pubdate",
                       "platform": "web", "web_location": 1550101})
        return self.get("https://api.bilibili.com/x/space/wbi/arc/search?" + q, tier="space")["data"]

    def view(self, bvid):
        return self.get("https://api.bilibili.com/x/web-interface/view?bvid=" + bvid,
                        "https://www.bilibili.com/")["data"]
