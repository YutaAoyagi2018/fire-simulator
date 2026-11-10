"""生データを data/raw/ に取得（更新）する。公開用：再配布の制約が少ないデータだけ。

  python build/fetch_data.py          # 毎月変わるもの（French・FRB・総務省）を取り直す
  python build/fetch_data.py --all    # Shiller も含めてすべて

その後 python build/build_data.py で web/data.js を作り直す。

| ファイル | 出典 |
|---|---|
| ff_factors.zip / ff_dev.zip | Kenneth R. French Data Library（米国・先進国の株式市場） |
| fed_h10_jpy_*.htm | 米連邦準備制度理事会 H.10 Historical Rates for the Japanese Yen |
| estat_cpi_monthly.csv | 総務省統計局 消費者物価指数 長期時系列データ（e-Stat） |
| ie_data.xls | Robert J. Shiller, Online Data（1926年より前の株価と米国CPI） |
"""
from __future__ import annotations

import argparse
import html
import re
import sys
import urllib.request
from pathlib import Path

RAW = Path(__file__).resolve().parent.parent / "data" / "raw"
UA = {"User-Agent": "Mozilla/5.0 (FireSim data fetch)"}
FRENCH = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/{name}_CSV.zip"
FED = "https://www.federalreserve.gov/releases/h10/hist/dat{yy}_ja.htm"
# e-Stat: 2025年基準 長期時系列データ › 全国 › 月次 の一覧ページ（先頭が「中分類指数（1970年1月〜最新月）」）
ESTAT_LIST = ("https://www.e-stat.go.jp/stat-search/files?tstat=000001243876&toukei=00200573&cycle=0"
              "&tclass1=000001243880&tclass2=000001243881&tclass3=000001243883&tclass4=000001243886"
              "&layout=datalist&page=1&tclass5val=0")

MONTHLY = {
    "ff_factors.zip": FRENCH.format(name="F-F_Research_Data_Factors"),
    "ff_dev.zip": FRENCH.format(name="Developed_3_Factors"),
    "fed_h10_jpy_89.htm": FED.format(yy="89"),
    "fed_h10_jpy_96.htm": FED.format(yy="96"),
    "fed_h10_jpy_00.htm": FED.format(yy="00"),
}
STATIC = {"ie_data.xls": "http://www.econ.yale.edu/~shiller/data/ie_data.xls"}


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        return r.read()


def get(name: str, url: str) -> None:
    try:
        data = fetch(url)
    except Exception as e:  # 1つ失敗しても他は続ける（前回のファイルが残る）
        print(f"  失敗 {name}: {e}")
        return
    (RAW / name).write_bytes(data)
    print(f"  {name}: {len(data):,} bytes")


def estat_cpi() -> None:
    """一覧ページの先頭のCSV（中分類指数・月次・全国）を取る。ファイルIDは更新で変わるため毎回探す"""
    try:
        page = fetch(ESTAT_LIST).decode("utf-8", "replace")
        links = re.findall(r'(/stat-search/file-download\?statInfId=\d+&(?:amp;)?fileKind=1)', page)
        if not links:
            raise RuntimeError("CSV のリンクが見つかりません")
        get("estat_cpi_monthly.csv", "https://www.e-stat.go.jp" + html.unescape(links[0]))
    except Exception as e:
        print(f"  失敗 estat_cpi_monthly.csv: {e}")


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    a = ap.parse_args()
    RAW.mkdir(parents=True, exist_ok=True)
    for name, url in MONTHLY.items():
        get(name, url)
    estat_cpi()
    for name, url in STATIC.items():
        if a.all or not (RAW / name).exists():
            get(name, url)


if __name__ == "__main__":
    main()
