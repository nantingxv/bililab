"""自动记录调度器 + 开机启动项（HKCU\\...\\Run）。"""
import datetime
import os
import sys
import threading
import time
import winreg

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_NAME = "BiliLab"

DEFAULTS = {"enabled": False, "alarms": ["06:00"], "max_videos": 20, "rate": 8,
            "last_run": None, "last_runs": {}}


def norm(cfg):
    a = cfg.get("auto") or {}
    for k, v in DEFAULTS.items():
        a.setdefault(k, v)
    a.pop("interval_hours", None)      # 旧字段，已由 alarms 取代
    cfg["auto"] = a
    return a


# ---------------- 开机启动 ----------------
def startup_command():
    exe = sys.executable
    pyw = os.path.join(os.path.dirname(exe), "pythonw.exe")
    if os.path.exists(pyw):
        exe = pyw
    return '"%s" "%s"' % (exe, os.path.join(ROOT, "server.py"))


def get_startup():
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            v, _ = winreg.QueryValueEx(k, RUN_NAME)
            return v
    except FileNotFoundError:
        return None
    except OSError:
        return None


def set_startup(enable):
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
        if enable:
            winreg.SetValueEx(k, RUN_NAME, 0, winreg.REG_SZ, startup_command())
        else:
            try:
                winreg.DeleteValue(k, RUN_NAME)
            except FileNotFoundError:
                pass
    return get_startup()


# ---------------- 调度 ----------------
class Scheduler(threading.Thread):
    """闹铃式调度：每天在指定的若干时刻各跑一次（时刻限定 00:00–23:59）。

    每 20 秒醒一次，检查「今天这个时刻是否已经跑过」；没跑过且没超时就开始。
    超过 GRACE_MIN 分钟的闹铃视为错过（例如电脑整晚关机），当天不再补跑。
    """

    GRACE_MIN = 90

    def __init__(self, get_cfg, save_cfg, is_busy, trigger):
        super().__init__(daemon=True)
        self.get_cfg = get_cfg
        self.save_cfg = save_cfg
        self.is_busy = is_busy
        self.trigger = trigger
        self._halt = threading.Event()

    def stop(self):
        self._halt.set()

    # ---- 工具 ----
    @staticmethod
    def parse(hhmm):
        try:
            h, m = str(hhmm).split(":")
            h, m = int(h), int(m)
            if 0 <= h <= 23 and 0 <= m <= 59:
                return h, m
        except Exception:
            pass
        return None

    def _today_target(self, hhmm, now=None):
        parsed = self.parse(hhmm)
        if not parsed:
            return None
        now = now or datetime.datetime.now()
        return now.replace(hour=parsed[0], minute=parsed[1], second=0, microsecond=0)

    # ---- 供 UI 查询 ----
    def next_run_ts(self):
        a = norm(self.get_cfg())
        if not a.get("enabled"):
            return None
        alarms = sorted(x for x in (a.get("alarms") or []) if self.parse(x))
        if not alarms:
            return None
        now = datetime.datetime.now()
        today = now.strftime("%Y-%m-%d")
        runs = a.get("last_runs") or {}
        for hhmm in alarms:
            t = self._today_target(hhmm, now)
            late = (now - t).total_seconds() / 60
            if runs.get(hhmm) != today and -1 <= late <= self.GRACE_MIN:
                return now.timestamp()          # 待触发
            if t > now:
                return t.timestamp()            # 今天接下来最近的一个
        # 今天都过完了 → 明天最早的
        first = alarms[0]
        t = self._today_target(first, now) + datetime.timedelta(days=1)
        return t.timestamp()

    # ---- 主循环 ----
    def run(self):
        while not self._halt.is_set():
            time.sleep(20)
            try:
                a = norm(self.get_cfg())
                if not a.get("enabled"):
                    continue
                now = datetime.datetime.now()
                today = now.strftime("%Y-%m-%d")
                runs = a.setdefault("last_runs", {})
                for hhmm in sorted(x for x in (a.get("alarms") or []) if self.parse(x)):
                    t = self._today_target(hhmm, now)
                    late_min = (now - t).total_seconds() / 60
                    if runs.get(hhmm) == today:
                        continue
                    if 0 <= late_min <= self.GRACE_MIN:
                        if self.is_busy():
                            break
                        runs[hhmm] = today
                        a["last_run"] = time.time()
                        self.save_cfg(self.get_cfg())
                        self.trigger(a)
                        break
                    if late_min > self.GRACE_MIN:
                        runs[hhmm] = today      # 记成已错过，避免无限判定
                        self.save_cfg(self.get_cfg())
            except Exception:
                continue
