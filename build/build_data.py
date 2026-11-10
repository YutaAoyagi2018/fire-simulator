"""全世界株式インデックスファンドを想定した月次リターン系列を作る（公開用：再配布の制約が少ないデータだけを使う）。

出力: web/data.js（window.FIRE_DATA）

つなぎ方（新しい順）
  D 1990-07〜  先進国株式市場（Ken French Data Library, Developed Markets, ドル建て）× ドル円 − 信託報酬
  C 1973-02〜1990-06  米国株式市場（Ken French / CRSP 全米, ドル建て）× ドル円 − 信託報酬
  B 1926-07〜1973-01  米国株式市場（Ken French / CRSP）。固定相場の時代なので円換算せず、米国CPIで実質化
  A 1871-02〜1926-06  S&P 500 配当込み（Robert Shiller）。同上

ドル円: 米連邦準備制度理事会 H.10（日次, 1971〜）の月末値。米国政府の公表データ（パブリックドメイン）
物価:   1973年2月以降は日本の消費者物価指数（総務省統計局, e-Stat, 総合）、それ以前は米国CPI（Shiller のデータ集に収録された BLS の CPI）

使い方: python build/build_data.py
"""
from __future__ import annotations

import html
import json
import re
import warnings
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "web" / "data.js"
FEE_ANNUAL = 0.0005775  # 低コストの全世界株式インデックスファンド相当（年0.058%）
FEE_M = (1 - FEE_ANNUAL) ** (1 / 12) - 1
MONTHS = {m: i + 1 for i, m in enumerate(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"])}


def load_shiller() -> pd.DataFrame:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        raw = pd.read_excel(RAW / "ie_data.xls", sheet_name="Data", header=None, skiprows=8)
    raw = raw.iloc[:, [0, 1, 2, 4]]
    raw.columns = ["date", "P", "D", "CPI"]
    raw = raw[pd.to_numeric(raw["date"], errors="coerce").notna()].copy()
    d = raw["date"].astype(float)
    year = np.floor(d).astype(int)
    month = np.rint((d - year) * 100).astype(int)
    raw.index = pd.PeriodIndex.from_fields(year=year, month=month, freq="M")
    return raw[["P", "D", "CPI"]].apply(pd.to_numeric, errors="coerce")


def load_french(zpath: Path) -> pd.DataFrame:
    """Ken French の月次ファクター CSV（最初の月次ブロックのみ）→ % を小数に"""
    with zipfile.ZipFile(zpath) as z:
        text = z.read(z.namelist()[0]).decode("latin-1")
    rows, started = [], False
    for line in text.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if parts and parts[0].isdigit() and len(parts[0]) == 6:
            started = True
            rows.append(parts)
        elif started:
            break
    df = pd.DataFrame(rows).set_index(0)
    df.index = pd.PeriodIndex([f"{s[:4]}-{s[4:]}" for s in df.index], freq="M")
    df = df.astype(float) / 100.0
    df.columns = ["MktRF", "SMB", "HML", "RF"][: df.shape[1]]
    return df


def load_fed_fx() -> pd.Series:
    """FRB H.10 の日次ドル円（3ファイル）→ 月末値"""
    vals = {}
    for name in ["fed_h10_jpy_89.htm", "fed_h10_jpy_96.htm", "fed_h10_jpy_00.htm"]:
        s = (RAW / name).read_text(encoding="utf-8", errors="replace")
        for row in re.findall(r"<tr[^>]*>(.*?)</tr>", s, re.S):
            cells = re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", row, re.S)
            if len(cells) < 2:
                continue
            txt = [html.unescape(re.sub(r"<[^>]+>", "", c)).replace("\xa0", " ").strip() for c in cells[:2]]
            m = re.match(r"(\d{1,2})-([A-Za-z]{3})-?(\d{2})$", txt[0].replace(" ", ""))
            if not m:
                continue
            try:
                v = float(txt[1])
            except ValueError:
                continue  # ND（休日）
            yy = int(m.group(3))
            y = 1900 + yy if yy >= 50 else 2000 + yy
            vals[pd.Timestamp(y, MONTHS[m.group(2).upper()], int(m.group(1)))] = v
    daily = pd.Series(vals).sort_index()
    return daily.groupby(daily.index.to_period("M")).last()


def load_jp_cpi() -> pd.Series:
    """総務省統計局 消費者物価指数 長期時系列（全国・月次・総合）"""
    text = (RAW / "estat_cpi_monthly.csv").read_bytes().decode("cp932", errors="replace")
    vals = {}
    for line in text.splitlines():
        parts = line.split(",")
        if len(parts) > 1 and re.fullmatch(r"\d{6}", parts[0]) and parts[1].strip():
            vals[pd.Period(f"{parts[0][:4]}-{parts[0][4:]}", "M")] = float(parts[1])
    return pd.Series(vals).sort_index()


def main() -> None:
    sh = load_shiller()
    us = load_french(RAW / "ff_factors.zip")
    dev = load_french(RAW / "ff_dev.zip")
    fx = load_fed_fx()
    jcpi = load_jp_cpi()

    us_mkt = us["MktRF"] + us["RF"]
    dev_mkt = dev["MktRF"] + dev["RF"]
    last = min(dev_mkt.index[-1], fx.index[-1])
    idx = pd.period_range("1871-02", last, freq="M")
    r = pd.Series(np.nan, index=idx)
    inf = pd.Series(np.nan, index=idx)
    src = pd.Series(-1, index=idx)

    sp_tr = (sh["P"] + sh["D"] / 12) / sh["P"].shift(1) - 1
    us_inf = sh["CPI"] / sh["CPI"].shift(1) - 1
    fx_ret = fx / fx.shift(1) - 1
    jinf = jcpi / jcpi.shift(1) - 1

    def jpy(usd_ret: float, p: pd.Period) -> float:
        return ((1 + usd_ret) * (1 + fx_ret[p])) * (1 + FEE_M) - 1

    for p in pd.period_range("1871-02", "1926-06", freq="M"):
        r[p], inf[p], src[p] = sp_tr[p], us_inf[p], 0
    for p in pd.period_range("1926-07", "1973-01", freq="M"):
        r[p], inf[p], src[p] = us_mkt[p], us_inf[p], 1
    for p in pd.period_range("1973-02", "1990-06", freq="M"):
        r[p], src[p] = jpy(us_mkt[p], p), 2
    for p in pd.period_range("1990-07", last, freq="M"):
        r[p], src[p] = jpy(dev_mkt[p], p), 3
    for p in pd.period_range("1973-02", last, freq="M"):
        inf[p] = jinf.get(p, np.nan)

    missing = inf[inf.isna()]
    if len(missing):
        fill = inf.dropna().iloc[-12:].mean()
        inf = inf.fillna(fill)
        print(f"CPI を補完: {[str(p) for p in missing.index]} ← 月{fill:.4%}")
    assert not r.isna().any(), r[r.isna()]

    segs = [
        {"id": "A", "from": "1871-02", "to": "1926-06", "name": "米国株（S&P 500）", "short": "米国株",
         "note": "Robert Shiller の配当込みS&P 500。固定相場の時代なのでドル建てのまま米国CPIで実質化（為替の実質価値は一定と仮定）"},
        {"id": "B", "from": "1926-07", "to": "1973-01", "name": "米国株（CRSP 全米）", "short": "米国株",
         "note": "Ken French Data Library の米国株式市場（配当込み）。同じく米国CPIで実質化"},
        {"id": "C", "from": "1973-02", "to": "1990-06", "name": "米国株 × ドル円", "short": "米国株×円",
         "note": "米国株式市場をFRB（H.10）のドル円月末値で円換算し、信託報酬（年0.058%）を控除"},
        {"id": "D", "from": "1990-07", "to": str(last), "name": "先進国株 × ドル円", "short": "先進国株×円",
         "note": "Ken French Data Library の先進国株式市場（配当込み・新興国を含まない）を円換算し、信託報酬を控除"},
    ]

    annual = []
    for y in sorted({p.year for p in idx}):
        m = [p for p in idx if p.year == y]
        annual.append([y, round(float((1 + r[m]).prod() - 1), 5), round(float((1 + inf[m]).prod() - 1), 5), int(src[m[-1]])])

    data = {
        "start": str(idx[0]), "end": str(idx[-1]),
        "r": [round(float(x), 6) for x in r.values],
        "inf": [round(float(x), 6) for x in inf.values],
        "src": [int(x) for x in src.values],
        "segments": segs, "annual": annual, "fee": FEE_ANNUAL,
        "fxLatest": {"month": str(fx.index[-1]), "usdjpy": round(float(fx.iloc[-1]), 2)},
        "built": pd.Timestamp.now().strftime("%Y-%m-%d"),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("// build/build_data.py で生成。手で直さない\nwindow.FIRE_DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")

    def ann(x: pd.Series) -> float:
        return float((1 + x).prod() ** (12 / len(x)) - 1)

    real = (1 + r) / (1 + inf) - 1
    print(f"{idx[0]}〜{idx[-1]}  {len(idx)}ヶ月  -> {OUT.relative_to(ROOT)} ({OUT.stat().st_size:,} bytes)")
    for s in segs:
        m = pd.period_range(s["from"], s["to"], freq="M")
        print(f"  {s['id']} {s['from']}〜{s['to']} 名目{ann(r[m]):+.2%} 実質{ann(real[m]):+.2%}  {s['name']}")
    print(f"  全期間 名目{ann(r):+.2%} 実質{ann(real):+.2%}")


if __name__ == "__main__":
    main()
