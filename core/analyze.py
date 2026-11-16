"""分析层：账号聚合、跨账号对比、多快照速率与边际互动率。"""
import datetime
import statistics
import time


def _med(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def _sum(xs):
    return sum(x for x in xs if x)


DUR_EDGES = [60, 120, 180, 300, 480, 900]   # <1分 <2 <3 <5 <8 <15 >=15


def _dur_sec(s):
    try:
        p = [int(x) for x in (s or "").split(":")]
        if len(p) == 2:
            return p[0] * 60 + p[1]
        if len(p) == 3:
            return p[0] * 3600 + p[1] * 60 + p[2]
    except Exception:
        pass
    return None


def duration_hist(videos):
    hist = [0] * (len(DUR_EDGES) + 1)
    for v in videos:
        d = _dur_sec(v.get("duration"))
        if d is None:
            continue
        for i, e in enumerate(DUR_EDGES):
            if d < e:
                hist[i] += 1
                break
        else:
            hist[-1] += 1
    return hist


def _flat(snap):
    rows = []
    now = time.time()
    for a in snap.get("accounts") or []:
        for v in a.get("videos") or []:
            view = v.get("view") or 0
            s3 = (v.get("like") or 0) + (v.get("coin") or 0) + (v.get("favorite") or 0)
            rows.append({
                "mid": a["mid"], "uname": a.get("uname"),
                "bvid": v["bvid"], "title": v.get("title"),
                "pubdate": v.get("pubdate"), "duration": v.get("duration"),
                "view": view, "like": v.get("like") or 0,
                "coin": v.get("coin") or 0, "favorite": v.get("favorite") or 0,
                "reply": v.get("reply") or 0, "danmaku": v.get("danmaku") or 0,
                "share": v.get("share") or 0,
                "engagement": round(s3 / view, 4) if view else None,
                "hour": time.localtime(v["pubdate"]).tm_hour if v.get("pubdate") else None,
                "age_hours": round((now - (v.get("pubdate") or now)) / 3600, 2),
            })
    return rows


def _hour_hist(a):
    """按本地时刻的 24 格发布计数；老快照没有该字段就从视频时间现算。"""
    h = a.get("hour_hist")
    if isinstance(h, list) and len(h) == 24:
        return h
    hist = [0] * 24
    for v in a.get("videos") or []:
        if v.get("pubdate"):
            hist[time.localtime(v["pubdate"]).tm_hour] += 1
    return hist


def _eng(v):
    s = (v.get("like") or 0) + (v.get("coin") or 0) + (v.get("favorite") or 0)
    return s / v["view"] if v.get("view") else None


def account_summary(a, max_videos=None):
    vs = [v for v in (a.get("videos") or []) if v.get("view") is not None]
    views = [v["view"] for v in vs]
    likes = _sum(v.get("like") for v in vs)
    coins = _sum(v.get("coin") for v in vs)
    favs = _sum(v.get("favorite") for v in vs)
    replies = _sum(v.get("reply") for v in vs)
    pub = sorted([v["pubdate"] for v in vs if v.get("pubdate")])
    # 前后半段中位播放：衡量「越做越差」还是「越做越好」
    ordered = sorted(vs, key=lambda v: v.get("pubdate") or 0)
    half = len(ordered) // 2
    early = [v["view"] for v in ordered[:half]] if half else []
    late = [v["view"] for v in ordered[half:]] if half else []
    hist = _hour_hist(a)
    total_h = sum(hist) or 1
    peak = max(range(24), key=lambda i: hist[i]) if any(hist) else None
    night = sum(hist[0:6])
    span_days = ((max(pub) - min(pub)) / 86400) if len(pub) > 1 else None
    # 首条视频是否可信：抓到的条数少于上限，说明已经取到了他全部作品
    total_v = a.get("video_total")
    first_known = bool((total_v is not None and len(vs) >= total_v)
                       or (max_videos and len(vs) < max_videos)
                       or not max_videos)
    return {
        "mid": a["mid"], "uname": a.get("uname"), "sign": a.get("sign"),
        "face": a.get("face"), "follow_time": a.get("follow_time"),
        "follower": a.get("follower"), "following": a.get("following"),
        "video_total": a.get("video_total"), "videos_fetched": len(vs),
        "sum_view": _sum(views), "median_view": _med(views), "max_view": max(views) if views else 0,
        "sum_like": likes, "sum_coin": coins, "sum_fav": favs, "sum_reply": replies,
        "engagement": (likes + coins + favs) / _sum(views) if _sum(views) else None,
        "avg_engagement": _med([_eng(v) for v in vs]),
        "views_per_video": _sum(views) / len(vs) if vs else None,
        "last_post": max(pub) if pub else None,
        "first_post": min(pub) if pub else None,
        "first_post_known": first_known,
        "hour_hist": hist,
        "duration_hist": duration_hist(vs),
        "peak_hour": peak,
        "night_share": round(night / total_h, 3) if any(hist) else None,
        "posts_per_day": round(len(vs) / span_days, 2) if span_days else None,
        "early_median_view": _med(early), "late_median_view": _med(late),
        "decline_ratio": (_med(late) / _med(early)) if (early and late and _med(early)) else None,
        "error": a.get("error"),
    }


def _trend_accounts(accts, prev, dt_h):
    """账号级变化：播放增量、粉丝增量、新发视频数。"""
    pm = {}
    for a in prev.get("accounts") or []:
        pm[a["mid"]] = {
            "follower": a.get("follower"),
            "sum_view": sum((v.get("view") or 0) for v in (a.get("videos") or [])),
            "bvids": {v.get("bvid") for v in (a.get("videos") or [])},
        }
    out = []
    for a in accts:
        p = pm.get(a["mid"])
        if not p:
            continue
        dv = a["sum_view"] - p["sum_view"]
        df = (a["follower"] - p["follower"]) if (a["follower"] is not None and p["follower"] is not None) else None
        cur_bv = set()
        for m in a.get("videos") or []:
            cur_bv.add(m.get("bvid"))
        new_v = len(cur_bv - p["bvids"])
        out.append({
            "mid": a["mid"], "uname": a["uname"], "follower": a["follower"],
            "d_follower": df, "d_view": dv,
            "velocity": (dv / dt_h) if dt_h else None,
            "new_videos": new_v, "sum_view": a["sum_view"],
        })
    return out


_META_CACHE = {}


def _snap_meta(load, sid):
    """(快照时间戳, 各账号最近投稿时间) —— 只解析一次，之后走缓存。"""
    if sid in _META_CACHE:
        return _META_CACHE[sid]
    s = load(sid)
    if not s:
        return None
    t = _parse(s.get("created_at"))
    lp = []
    for a in s.get("accounts") or []:
        pub = [v["pubdate"] for v in (a.get("videos") or []) if v.get("pubdate")]
        if pub:
            lp.append(max(pub))
    meta = (t or 0, lp)
    if len(_META_CACHE) > 80:
        _META_CACHE.clear()
    _META_CACHE[sid] = meta
    del s
    return meta


def _last_posts(snap):
    """每个账号在该快照时刻的「最近一次投稿时间」，带缓存。"""
    sid = snap.get("snapshot_id")
    if sid in _LASTPOST_CACHE:
        return _LASTPOST_CACHE[sid]
    out = []
    for a in snap.get("accounts") or []:
        pub = [v["pubdate"] for v in (a.get("videos") or []) if v.get("pubdate")]
        if pub:
            out.append(max(pub))
    if len(_LASTPOST_CACHE) > 80:
        _LASTPOST_CACHE.clear()
    _LASTPOST_CACHE[sid] = out
    return out


def survival_series(load, ids, n_days, window_days):
    """按快照时间序列，统计「截止该时刻，超过 n 天没更新」的账号数。

    逐个加载快照，用完即释放——36 份快照同时驻留会吃掉几个 GB。
    """
    cutoff = time.time() - window_days * 86400
    rows = []
    for sid in ids:
        meta = _snap_meta(load, sid)
        if not meta:
            continue
        t, lp = meta
        if not t or t < cutoff:
            continue
        dead = sum(1 for x in lp if (t - x) > n_days * 86400)
        rows.append({
            "snapshot_id": sid,
            "at": datetime.datetime.fromtimestamp(t).astimezone().isoformat(),
            "dead": dead,
            "alive": len(lp) - dead,
            "total": len(lp),
        })
    return {"n_days": n_days, "window_days": window_days, "rows": rows}


def _survival_change(snap, prev):
    def buckets(s):
        t = _parse(s.get("created_at")) or time.time()
        edges = [1, 2, 3, 5, 7]
        b = [0] * 6
        for a in s.get("accounts") or []:
            pub = [v["pubdate"] for v in (a.get("videos") or []) if v.get("pubdate")]
            if not pub:
                continue
            d = (t - max(pub)) / 86400
            i = 0
            while i < len(edges) and d >= edges[i]:
                i += 1
            b[i] += 1
        return b
    return {"prev": buckets(prev), "cur": buckets(snap),
            "labels": ["<1天", "1–2天", "2–3天", "3–5天", "5–7天", ">7天"]}


def build_dashboard(snap, prev=None):
    rows = _flat(snap)
    accts = [account_summary(a, (snap.get("params") or {}).get("max_videos"))
             for a in snap.get("accounts") or []]
    views = [r["view"] for r in rows]
    likes = _sum(r["like"] for r in rows)
    coins = _sum(r["coin"] for r in rows)
    favs = _sum(r["favorite"] for r in rows)
    replies = _sum(r["reply"] for r in rows)
    followers = _sum(a["follower"] for a in accts)
    inst = [a for a in accts if a["engagement"] is not None]
    n_b = len(DUR_EDGES) + 1
    group_dur = [0] * n_b
    for a in accts:
        dh = a.get("duration_hist") or []
        for i in range(min(n_b, len(dh))):
            group_dur[i] += dh[i]
    group_hist = [0] * 24
    for a in accts:
        for i, n in enumerate(a["hour_hist"]):
            group_hist[i] += n
    g_total = sum(group_hist) or 1
    g_peak = max(range(24), key=lambda i: group_hist[i]) if any(group_hist) else None

    overview = {
        "accounts": len(accts),
        "videos": len(rows),
        "accounts_with_video": len({r["mid"] for r in rows}),
        "sum_view": _sum(views), "sum_like": likes, "sum_coin": coins,
        "sum_fav": favs, "sum_reply": replies,
        "sum_follower": followers,
        "median_view": _med(views), "median_engagement": _med([a["engagement"] for a in inst]),
        "median_follower": _med([a["follower"] for a in accts if a["follower"] is not None]),
        "max_view": max(views) if views else 0,
        "peak_hour": g_peak,
        "night_share": round(sum(group_hist[0:6]) / g_total, 3),
        "created_at": snap.get("created_at"),
        "params": snap.get("params"),
        "aborted": snap.get("aborted"),
    }

    trend = None
    if prev:
        prev_map = {}
        for a in prev.get("accounts") or []:
            for v in a.get("videos") or []:
                prev_map[v["bvid"]] = dict(v, mid=a["mid"])
        prev_ts = _parse(prev.get("created_at"))
        cur_ts = _parse(snap.get("created_at"))
        dt_h = (cur_ts - prev_ts) / 3600 if (prev_ts and cur_ts) else None
        items = []
        if dt_h and dt_h > 0.05:
            for r in rows:
                p = prev_map.get(r["bvid"])
                if not p:
                    continue
                dv = r["view"] - (p.get("view") or 0)
                de = ((r["like"] + r["coin"] + r["favorite"])
                      - ((p.get("like") or 0) + (p.get("coin") or 0) + (p.get("favorite") or 0)))
                items.append({
                    "bvid": r["bvid"], "mid": r["mid"], "uname": r["uname"], "title": r["title"],
                    "age_hours": r["age_hours"], "view": r["view"],
                    "d_view": dv, "velocity": dv / dt_h, "d_eng": de,
                    "marginal_engagement": (de / dv) if dv > 0 else None,
                    "prev_view": p.get("view") or 0,
                })
        trend = {"prev_snapshot": prev.get("snapshot_id"), "hours": round(dt_h, 2) if dt_h else None,
                 "items": items,
                 "accounts": _trend_accounts(accts, prev, dt_h),
                 "survival": _survival_change(snap, prev)}

    return {
        "meta": {"snapshot_id": snap.get("snapshot_id"), "created_at": snap.get("created_at"),
                 "params": snap.get("params")},
        "overview": overview,
        "hours": group_hist,
        "durations": group_dur,
        "accounts": accts,
        "videos": rows,
        "trend": trend,
    }


def _parse(iso):
    import datetime
    try:
        return datetime.datetime.strptime(iso, "%Y-%m-%dT%H:%M:%S%z").timestamp()
    except Exception:
        return None
