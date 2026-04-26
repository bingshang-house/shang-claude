"""
抓 dgbas（主計總處）每月更新的「以下年度為基準之消費者物價總指數—稅務專用」xls
解析成 data/cpi-tax-index.json，供前端土增稅試算 / 房地合一稅試算用

來源：https://ws.dgbas.gov.tw/001/Upload/463/relfile/10315/2649/cpispleym.xls
xls 結構：A 欄民國年 × B-M 欄 1-12 月 × N 欄累計平均；基期月對應值 = 100.0
"""

import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

import xlrd

URL = "https://ws.dgbas.gov.tw/001/Upload/463/relfile/10315/2649/cpispleym.xls"
TMP = "cpispleym.xls"
OUT = "data/cpi-tax-index.json"


def fetch():
    print(f"[fetch] {URL}", flush=True)
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r, open(TMP, "wb") as f:
            f.write(r.read())
    except (ssl.SSLError, urllib.error.URLError) as e:
        print(f"[fetch] SSL verify failed, retry without verify: {e}", flush=True)
        ctx = ssl._create_unverified_context()
        with urllib.request.urlopen(req, timeout=60, context=ctx) as r, open(TMP, "wb") as f:
            f.write(r.read())
    print(f"[fetch] saved {TMP} ({os.path.getsize(TMP)} bytes)", flush=True)


def parse():
    wb = xlrd.open_workbook(TMP)
    s = wb.sheet_by_index(0)
    indexes = {}

    for r in range(4, s.nrows):
        try:
            year_val = s.cell_value(r, 0)
            if year_val == "" or year_val is None:
                continue
            year = int(float(year_val))
        except (ValueError, TypeError):
            continue
        if year < 30 or year > 200:
            continue

        months = {}
        for c in range(1, 13):
            v = s.cell_value(r, c)
            if isinstance(v, (int, float)) and v > 0:
                months[str(c)] = round(float(v), 2)
        if months:
            indexes[str(year)] = months

    if not indexes:
        raise RuntimeError("解析失敗：indexes 是空的")

    last_year = max(int(k) for k in indexes.keys())
    last_months = indexes[str(last_year)]
    last_month = max(int(m) for m in last_months.keys())
    base_date = f"{last_year:03d}/{last_month:02d}"

    out = {
        "source": URL,
        "baseDate": base_date,
        "baseDateNote": f"民國 {last_year} 年 {last_month} 月為基期（指數=100）",
        "lastUpdated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "yearRange": [min(int(k) for k in indexes.keys()), last_year],
        "indexes": indexes,
    }

    os.makedirs("data", exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    yrs = len(indexes)
    print(
        f"[parse] {OUT}: {yrs} years ({out['yearRange'][0]}~{out['yearRange'][1]}), base={base_date}",
        flush=True,
    )


def main():
    try:
        fetch()
        parse()
    finally:
        if os.path.exists(TMP):
            os.remove(TMP)


if __name__ == "__main__":
    main()
