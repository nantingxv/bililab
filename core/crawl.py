"""抓取引擎：账号级并发 + 增量落盘 + 可中断。"""
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SNAP_DIR = os.path.join(ROOT, "data", "snapshots")
TZ = timezone(timedelta(hours=8))


def _now_iso():
    return datetime.now(TZ).strftime("%Y-%m-%dT%H:%M:%S+08:00")


class Progress:
    def __init__(self):
        self.lock = threading.Lock()
        self.data = {
            "running": False, "phase": "idle", "message": "",
            "snapshot_id": None,
            "accounts_total": 0, "accounts_done": 0,
            "videos_done": 0, "videos_est": 0,
            "ok": 0, "fail": 0, "retry": 0, "rate": 0, "space_rate": 0, "req_per_s": 0,
            "started_at": None, "elapsed": 0, "eta": None,
            "current": "", "errors": [],
        }

    def update(self, **kw):
        with self.lock:
            self.data.update(kw)

    def bump(self, **kw):
        with self.lock:
            for k, v in kw.items():
                self.data[k] = self.data.get(k, 0) + v

    def snapshot(self):
        with self.lock:
            return json.loads(json.dumps(self.data))


def fetch_accounts(client, owner_mid, tag_ids):
    """全量关注 → 按分组过滤（服务端忽略 tagid 参数，只能本地筛）。"""
    out, pn = [], 1
    while True:
        d = client.followings(owner_mid, pn=pn, ps=50)
        out.extend(d.get("list") or [])
        total = d.get("total") or 0
        if not (d.get("list")) or len(out) >= total or pn > 60:
            break
        pn += 1
    seen, uniq = set(), []
    for u in out:
        if u["mid"] in seen:
            continue
        seen.add(u["mid"])
        uniq.append(u)
    if tag_ids:
        uniq = [u for u in uniq if set(u.get("tag") or []) & set(tag_ids)]
    return uniq


def collect_videos(client, mid, max_videos, stop_event):
    vids, pn, total = [], 1, None
    while True:
        if stop_event.is_set():
            break
        d = client.arc_search(mid, pn=pn, ps=50)
        page = d.get("page") or {}
        total = page.get("count", len(vids))
        vl = (d.get("list") or {}).get("vlist") or []
        for v in vl:
            vids.append({"bvid": v["bvid"], "aid": v.get("aid"), "title": v.get("title"),
                         "pubdate": v.get("created"), "duration": v.get("length"),
                         "desc": (v.get("description") or "")[:200]})
            if max_videos and len(vids) >= max_videos:
                return vids, total
        if not vl or len(vids) >= (total or 0) or pn > 20:
            break
        pn += 1
    return vids, (total if total is not None else len(vids))


def _crawl_account(client, a, max_videos, progress, stop_event):
    rec = {"mid": a["mid"], "uname": a.get("uname"), "sign": a.get("sign"),
           "face": a.get("face"), "follow_time": a.get("mtime"),
           "tags": a.get("tag") or [], "follower": None, "following": None,
           "video_total": None, "videos": [], "error": None}
    if stop_event.is_set():
        return None
    progress.update(current=rec["uname"] or str(rec["mid"]))
    try:
        st = client.stat(rec["mid"])
        rec["follower"] = st.get("follower")
        rec["following"] = st.get("following")
    except Exception as e:  # noqa: BLE001
        rec["error"] = "stat: %s" % e
    try:
        vids, total = collect_videos(client, rec["mid"], max_videos, stop_event)
        rec["video_total"] = total
        for v in vids:
            if stop_event.is_set():
                break
            try:
                d = client.view(v["bvid"])
                s = d.get("stat") or {}
                v.update({"view": s.get("view", 0), "like": s.get("like", 0),
                          "coin": s.get("coin", 0), "favorite": s.get("favorite", 0),
                          "reply": s.get("reply", 0), "danmaku": s.get("danmaku", 0),
                          "share": s.get("share", 0)})
                rec["videos"].append(v)
                progress.bump(videos_done=1, ok=1)
            except Exception as e:  # noqa: BLE001
                progress.bump(fail=1)
                with progress.lock:
                    if len(progress.data["errors"]) < 20:
                        progress.data["errors"].append("%s: %s" % (v["bvid"], e))
    except Exception as e:  # noqa: BLE001
        rec["error"] = (rec["error"] or "") + " | arc: %s" % e

    # 按本地时段统计该账号的发布分布（0-23 点各发了几条）
    hist = [0] * 24
    for v in rec["videos"]:
        ts = v.get("pubdate")
        if ts:
            hist[datetime.fromtimestamp(ts, TZ).hour] += 1
    rec["hour_hist"] = hist
    return rec


def run_sync(client, owner_mid, tag_ids, tag_name, max_videos, progress, stop_event, limit=0, workers=5):
    sid = datetime.now(TZ).strftime("%Y%m%dT%H%M%S")
    part = os.path.join(SNAP_DIR, sid + ".partial.jsonl")
    os.makedirs(SNAP_DIR, exist_ok=True)
    t0 = time.time()
    progress.update(running=True, phase="accounts", message="读取关注列表…",
                    snapshot_id=sid, started_at=_now_iso(), ok=0, fail=0, retry=0,
                    videos_done=0, accounts_done=0, errors=[], req_per_s=0)

    accounts = fetch_accounts(client, owner_mid, tag_ids)
    if limit:
        accounts = accounts[:limit]
    est = len(accounts) * (max_videos or 30)
    progress.update(accounts_total=len(accounts), phase="crawl", videos_est=est,
                    message="开始抓取 %d 个账号（%d 并发）" % (len(accounts), workers))

    done, recs = 0, []
    with open(part, "w", encoding="utf-8") as fh, \
            ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(_crawl_account, client, a, max_videos, progress, stop_event)
                for a in accounts]
        for fut in as_completed(futs):
            try:
                rec = fut.result()
            except Exception as e:  # noqa: BLE001
                rec = None
                progress.bump(fail=1)
                with progress.lock:
                    progress.data["errors"].append("account: %s" % e)
            if rec:
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                fh.flush()
                done += 1
            el = time.time() - t0
            vd = progress.data["videos_done"]
            proj = (vd / el) if el > 0 else 0
            st_ = client.stats
            progress.update(accounts_done=done, ok=st_["ok"], fail=st_["fail"],
                            retry=st_["retry"], elapsed=int(el),
                            rate=client.lim_view.current(),
                            space_rate=client.lim_space.current(),
                            req_per_s=round(st_["ok"] / el, 2) if el > 0 else 0,
                            eta=int((est - vd) / proj) if proj > 0 else None,
                            message="%d/%d 账号 · %d 条视频 · %.1f 请求/秒"
                                    % (done, len(accounts), vd, (st_["ok"] / el) if el > 0 else 0))
            if stop_event.is_set():
                break
        interrupted = stop_event.is_set()
        stop_event.set()  # 让剩余任务尽快退出

    recs = []
    with open(part, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                recs.append(json.loads(line))
    snap = {"schema": 2, "snapshot_id": sid, "created_at": _now_iso(),
            "params": {"max_videos": max_videos, "tag_ids": tag_ids, "tag_name": tag_name,
                       "workers": workers},
            "owner_mid": owner_mid, "accounts": recs,
            "stats": dict(client.stats), "elapsed": int(time.time() - t0),
            "aborted": interrupted}
    out = os.path.join(SNAP_DIR, sid + ".json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(snap, f, ensure_ascii=False)
    try:
        os.remove(part)
    except OSError:
        pass
    progress.update(running=False, phase="done",
                    message="完成：%d 个账号，%d 条视频，用时 %d 秒"
                            % (len(recs), progress.data["videos_done"], int(time.time() - t0)),
                    elapsed=int(time.time() - t0), eta=0)
    return sid


_SNAP_FILE_CACHE = {}


def list_snapshots():
    """列出所有快照的概要。按「文件名 + 修改时间 + 大小」缓存，避免每次重解析几十 MB。"""
    out = []
    if not os.path.isdir(SNAP_DIR):
        return out
    for fn in os.listdir(SNAP_DIR):
        if not fn.endswith(".json"):
            continue
        p = os.path.join(SNAP_DIR, fn)
        try:
            st = os.stat(p)
        except OSError:
            continue
        key = (st.st_mtime_ns, st.st_size)
        hit = _SNAP_FILE_CACHE.get(fn)
        if hit and hit[0] == key:
            out.append(hit[1])
            continue
        try:
            with open(p, "r", encoding="utf-8") as f:
                d = json.load(f)
            meta = {"snapshot_id": d["snapshot_id"], "created_at": d.get("created_at"),
                    "accounts": len(d.get("accounts") or []),
                    "videos": sum(len(a.get("videos") or []) for a in d.get("accounts") or []),
                    "max_videos": (d.get("params") or {}).get("max_videos")}
        except Exception:
            continue
        _SNAP_FILE_CACHE[fn] = (key, meta)
        out.append(meta)
    out.sort(key=lambda x: x.get("created_at") or "", reverse=True)
    return out


def load_snapshot(sid):
    p = os.path.join(SNAP_DIR, sid + ".json")
    if not os.path.exists(p):
        return None
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)
