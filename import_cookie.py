import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from core import auth  # noqa: E402

# 用法：python import_cookie.py [cookies.txt]
# 不传参数时读取脚本同目录的 cookies.txt
here = os.path.dirname(os.path.abspath(__file__))
path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "cookies.txt")
if not os.path.exists(path):
    print("找不到 cookies 文件：%s" % path)
    print("请把浏览器里的 Cookie 整行粘贴进该文件（至少包含 SESSDATA），或直接在看板「登录」页粘贴。")
    sys.exit(1)

cfg = auth.load_config()
text = open(path, encoding="utf-8").read()
sess = auth.login_paste(cfg, text)
print("session:", sess)
print("config keys:", list(cfg.keys()))
print("cookies_enc len:", len(cfg.get("cookies_enc") or ""))
print("plaintext leaked:", "SESSDATA" in open(auth.CONFIG, encoding="utf-8").read())
