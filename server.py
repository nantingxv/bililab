"""本地 Web 服务：登录、抓取任务、看板数据、导出。"""
import csv
import io
import json
import os
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

from core import analyze, auth, auto, bili, crawl  # noqa: E402

STATIC = os.path.join(ROOT, "static")
PORT = int(os.environ.get("BILI_PORT", "8765"))

STATE = {
    "cfg": auth.load_config(),
    "client": None,
    "session": None,
    "progress": crawl.Progress(),
    "stop": threading.Event(),
    "thread": None,
}
MIME = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
        ".png": "image/png", ".svg": "image/svg+xml"}


def _iso_ts(s):
    import datetime
    try:
        return datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%S%z").timestamp()
    except Exception:
        return time.time()


def _auto_trigger(a):
    """调度器到点后调用：用配置的参数跑一次快照。"""
    try:
        start_sync(int(a.get("max_videos") or 20), [391756240], "赛博养AI", 0, float(a.get("rate") or 8))
    except Exception as e:  # noqa: BLE001
        print("[auto] 触发失败: %s" % e)


def boot():
    cfg = STATE["cfg"]
    a = auto.norm(cfg)
    if not a.get("last_run"):
        snaps = crawl.list_snapshots()
        a["last_run"] = _iso_ts(snaps[0]["created_at"]) if snaps else time.time()
        auth.save_config(cfg)
    sess = auth.validate(cfg)
    if sess:
        STATE["session"] = sess
        STATE["client"] = bili.Client(auth.get_cookies(cfg))
        print("[boot] 已恢复登录态: %s (%s)" % (sess.get("uname"), sess.get("mid")))
    else:
        print("[boot] 未登录，等待扫码或粘贴")
    sched = auto.Scheduler(lambda: STATE["cfg"], auth.save_config,
                           lambda: bool(STATE["thread"] and STATE["thread"].is_alive()),
                           _auto_trigger)
    STATE["sched"] = sched
    sched.start()
    print("[boot] 自动记录: %s，闹铃 %s" % ("开" if a.get("enabled") else "关", ",".join(a.get("alarms") or [])))
    threading.Thread(target=_warm_survival, daemon=True).start()


def _warm_survival():
    """预热 /api/survival 的快照缓存，让第一次调节滑块就是秒回。"""
    try:
        ids = [s["snapshot_id"] for s in sorted(crawl.list_snapshots(),
                                                key=lambda x: x.get("created_at") or "")]
        t0 = time.time()
        analyze.survival_series(crawl.load_snapshot, ids, 3.0, 365.0)
        print("[boot] 存活数据预热完成 %.1fs（%d 份快照）" % (time.time() - t0, len(ids)))
    except Exception as e:
        print("[boot] 预热失败:", e)


def start_sync(max_videos, tag_ids, tag_name, limit=0, rate=8.0, workers=5):
    if STATE["thread"] and STATE["thread"].is_alive():
        return False, "已有任务在跑"
    cfg = STATE["cfg"]
    cookies = auth.get_cookies(cfg)
    if not cookies:
        return False, "未登录"
    client = bili.Client(cookies, rate=rate, space_rate=max(1.0, rate / 5.0))
    STATE["stop"] = threading.Event()
    prog = STATE["progress"]
    prog.data.update(running=True, phase="start", message="准备中", videos_done=0,
                     accounts_done=0, errors=[], elapsed=0, eta=None)
    mid = (STATE["session"] or {}).get("mid")

    def worker():
        try:
            sid = crawl.run_sync(client, mid, tag_ids, tag_name, max_videos, prog, STATE["stop"], limit, workers)
            cfg["last_snapshot"] = sid
            auth.save_config(cfg)
        except Exception as e:  # noqa: BLE001
            prog.update(running=False, phase="error", message="失败: %s" % e)
            raise

    t = threading.Thread(target=worker, daemon=True)
    STATE["thread"] = t
    t.start()
    return True, "已启动"


class Handler(BaseHTTPRequestHandler):
    server_version = "BiliLab/1.0"

    def log_message(self, fmt, *args):  # 静音
        pass

    # ---------- helpers ----------
    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False)
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    def _file(self, rel):
        p = os.path.normpath(os.path.join(STATIC, rel.lstrip("/")))
        if not p.startswith(STATIC) or not os.path.isfile(p):
            return self._send(404, {"error": "not found"})
        ext = os.path.splitext(p)[1].lower()
        with open(p, "rb") as f:
            data = f.read()
        self._send(200, data, MIME.get(ext, "application/octet-stream"))

    # ---------- routes ----------
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        path, qs = u.path, urllib.parse.parse_qs(u.query)
        try:
            if path == "/" or path == "/index.html":
                return self._file("index.html")
            if path.startswith("/static/"):
                return self._file(path[len("/static/"):])
            if path == "/api/state":
                cfg = STATE["cfg"]
                return self._send(200, {
                    "logged_in": bool(STATE["session"]),
                    "session": STATE["session"],
                    "snapshots": crawl.list_snapshots(),
                    "progress": STATE["progress"].snapshot(),
                })
            if path == "/api/login/qr":
                url, key = auth.qr_generate()
                return self._send(200, {"url": url, "key": key})
            if path == "/api/login/qr/poll":
                key = (qs.get("key") or [""])[0]
                st, cookies = auth.qr_poll(key)
                if st == 0 and cookies:
                    cfg = STATE["cfg"]
                    sess = auth.validate(cfg, cookies)
                    if sess:
                        STATE["session"] = sess
                        STATE["client"] = bili.Client(auth.get_cookies(cfg))
                        return self._send(200, {"state": 0, "session": sess})
                    return self._send(200, {"state": -1, "message": "登录成功但校验失败"})
                return self._send(200, {"state": st})
            if path == "/api/tags":
                if not STATE["client"]:
                    return self._send(401, {"error": "未登录"})
                mid = STATE["session"]["mid"]
                tags = STATE["client"].tags(mid)
                return self._send(200, {"tags": tags})
            if path == "/api/auto":
                cfg = STATE["cfg"]
                a = auto.norm(cfg)
                sched = STATE.get("sched")
                return self._send(200, {
                    "auto": a,
                    "next_run": sched.next_run_ts() if (sched and a.get("enabled")) else None,
                    "startup": bool(auto.get_startup()),
                    "startup_cmd": auto.startup_command(),
                    "busy": bool(STATE["thread"] and STATE["thread"].is_alive()),
                })
            if path == "/api/sync/status":
                return self._send(200, STATE["progress"].snapshot())
            if path == "/api/video_history":
                bvid = (qs.get("bvid") or [""])[0]
                if not bvid:
                    return self._send(400, {"error": "缺少 bvid"})
                out = []
                for s in crawl.list_snapshots():
                    snap = crawl.load_snapshot(s["snapshot_id"])
                    for a in (snap or {}).get("accounts") or []:
                        hit = None
                        for v in a.get("videos") or []:
                            if v.get("bvid") == bvid:
                                hit = v
                                break
                        if hit:
                            view = hit.get("view") or 0
                            s3 = (hit.get("like") or 0) + (hit.get("coin") or 0) + (hit.get("favorite") or 0)
                            out.append({"snapshot_id": s["snapshot_id"], "created_at": s["created_at"],
                                        "view": hit.get("view"), "like": hit.get("like"),
                                        "coin": hit.get("coin"), "favorite": hit.get("favorite"),
                                        "reply": hit.get("reply"), "danmaku": hit.get("danmaku"),
                                        "engagement": round(s3 / view, 4) if view else None})
                out.sort(key=lambda x: x["created_at"])
                return self._send(200, {"bvid": bvid, "points": out})
            if path == "/api/survival":
                try:
                    n_days = float((qs.get("n") or ["3"])[0])
                    win = float((qs.get("days") or ["14"])[0])
                except ValueError:
                    n_days, win = 3.0, 14.0
                n_days = max(0.5, min(60.0, n_days))
                win = max(1.0, min(120.0, win))
                ids = [s["snapshot_id"] for s in sorted(crawl.list_snapshots(),
                                                       key=lambda x: x.get("created_at") or "")]
                return self._send(200, analyze.survival_series(crawl.load_snapshot, ids, n_days, win))
            if path == "/api/dashboard":
                sid = (qs.get("snapshot_id") or [""])[0]
                snaps = crawl.list_snapshots()
                if not sid and snaps:
                    sid = snaps[0]["snapshot_id"]
                snap = crawl.load_snapshot(sid) if sid else None
                if not snap:
                    return self._send(404, {"error": "没有快照数据"})
                prev = None
                ids = [s["snapshot_id"] for s in snaps]
                if sid in ids:
                    i = ids.index(sid)
                    if i + 1 < len(ids):
                        prev = crawl.load_snapshot(ids[i + 1])
                data = analyze.build_dashboard(snap, prev)
                return self._send(200, data)
            if path == "/api/export":
                kind = (qs.get("kind") or ["videos"])[0]
                sid = (qs.get("snapshot_id") or [""])[0]
                snaps = crawl.list_snapshots()
                if not sid and snaps:
                    sid = snaps[0]["snapshot_id"]
                snap = crawl.load_snapshot(sid)
                if not snap:
                    return self._send(404, {"error": "无数据"})
                if kind == "json":
                    body = json.dumps(snap, ensure_ascii=False, indent=1)
                    return self._send(200, body, "application/json; charset=utf-8",
                                      {"Content-Disposition": 'attachment; filename="bili_%s.json"' % sid})
                dash = analyze.build_dashboard(snap)
                rows = dash["videos"] if kind == "videos" else dash["accounts"]
                buf = io.StringIO()
                if rows:
                    w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
                    w.writeheader()
                    for r in rows:
                        w.writerow({k: (json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v)
                                    for k, v in r.items()})
                return self._send(200, "\ufeff" + buf.getvalue(), "text/csv; charset=utf-8",
                                  {"Content-Disposition": 'attachment; filename="bili_%s_%s.csv"' % (sid, kind)})
            return self._send(404, {"error": "no route"})
        except Exception as e:  # noqa: BLE001
            return self._send(500, {"error": "%s: %s" % (type(e).__name__, e)})

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        path = u.path
        try:
            if path == "/api/login/paste":
                body = self._json_body()
                cfg = STATE["cfg"]
                sess = auth.login_paste(cfg, body.get("text", ""))
                STATE["session"] = sess
                STATE["client"] = bili.Client(auth.get_cookies(cfg))
                return self._send(200, {"ok": True, "session": sess})
            if path == "/api/logout":
                cfg = STATE["cfg"]
                cfg["cookies_enc"] = None
                cfg["session"] = {}
                auth.save_config(cfg)
                STATE["session"] = None
                STATE["client"] = None
                return self._send(200, {"ok": True})
            if path == "/api/sync":
                body = self._json_body()
                mv = int(body.get("max_videos") or 20)
                tags = body.get("tag_ids") or [391756240]
                tname = body.get("tag_name") or "赛博养AI"
                limit = int(body.get("limit") or 0)
                rate = float(body.get("rate") or 8.0)
                workers = int(body.get("workers") or max(2, min(8, int(rate // 2))))
                ok, msg = start_sync(mv, tags, tname, limit, rate, workers)
                return self._send(200 if ok else 409, {"ok": ok, "message": msg})
            if path == "/api/sync/stop":
                STATE["stop"].set()
                return self._send(200, {"ok": True})
            if path == "/api/auto":
                body = self._json_body()
                cfg = STATE["cfg"]
                a = auto.norm(cfg)
                was = bool(a.get("enabled"))
                for k, cast in (("max_videos", int), ("rate", float)):
                    if body.get(k) is not None:
                        a[k] = cast(body[k])
                if "enabled" in body:
                    a["enabled"] = bool(body["enabled"])
                if a["enabled"] and not was:
                    a["last_run"] = time.time()      # 开启时从当前时刻起算
                if "alarms" in body:
                    vals = []
                    for x in (body.get("alarms") or []):
                        pr = auto.Scheduler.parse(x)
                        if pr:
                            vals.append("%02d:%02d" % pr)
                    a["alarms"] = sorted(set(vals))
                    if not a["alarms"]:
                        a["enabled"] = False
                auth.save_config(cfg)
                sched = STATE.get("sched")
                return self._send(200, {"ok": True, "auto": a,
                                        "next_run": sched.next_run_ts() if (sched and a["enabled"]) else None})
            if path == "/api/startup":
                body = self._json_body()
                try:
                    v = auto.set_startup(bool(body.get("enabled")))
                except PermissionError:
                    return self._send(500, {"error": "当前服务进程没有写注册表的权限（通常在受限环境里运行）。"
                                                     "请直接双击项目目录里的「启用开机启动.bat」，"
                                                     "或关掉本服务后用「打开看板.bat」重新启动再试。"})
                return self._send(200, {"ok": True, "startup": bool(v),
                                        "startup_cmd": auto.startup_command()})
            return self._send(404, {"error": "no route"})
        except Exception as e:  # noqa: BLE001
            return self._send(500, {"error": "%s: %s" % (type(e).__name__, e)})


def main():
    boot()
    port = PORT
    for _ in range(20):
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            port += 1
    else:
        raise SystemExit("没有可用端口")
    url = "http://127.0.0.1:%d" % port
    print("[server] %s" % url, flush=True)
    if os.environ.get("BILI_OPEN") == "1":
        try:
            os.startfile(url)
        except Exception:
            pass
    httpd.serve_forever()


if __name__ == "__main__":
    main()
