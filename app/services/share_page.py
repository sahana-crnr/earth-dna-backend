"""Public share page (src/shoes/share.view.ts), rendered byte for byte."""

from __future__ import annotations

import math
from typing import Any

ACTION_LABEL = {
    "resell": "Resell this pair",
    "repair": "Repair this pair",
    "donate": "Donate this pair",
    "recycle": "Recycle this pair",
}


def escape_html(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def _money(v: Any) -> str | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    return f"${int(f)}" if f.is_integer() else f"${f:.2f}"


def value_text(v: dict[str, Any]) -> str | None:
    mn, mx = _money(v.get("min")), _money(v.get("max"))
    if mn and mx:
        return f"{mn}\u2013{mx}"
    return mx or mn


def share_title(v: dict[str, Any]) -> str:
    return " ".join(p for p in (v.get("brand"), v.get("model")) if p)


def share_description(v: dict[str, Any]) -> str:
    parts: list[str] = []
    cond = v.get("condition") or {}
    if cond.get("grade") or cond.get("label"):
        parts.append(" · ".join(p for p in (cond.get("grade"), cond.get("label")) if p))
    value = value_text(v.get("value") or {})
    if value:
        parts.append(f"Est. resale value {value}")
    return " — ".join(parts) or "Shared from S.H.O.E.S. by EarthDNA"


def render_share_html(v: dict[str, Any], page_url: str) -> str:
    title = escape_html(share_title(v))
    description = escape_html(share_description(v))
    url = escape_html(page_url)
    photo = escape_html(v["photoUrl"]) if v.get("photoUrl") else None
    sub = escape_html(
        " · ".join(p for p in (v.get("shoeType"), v.get("color")) if p) or ""
    )
    cond = v.get("condition") or {}
    condition = escape_html(
        " · ".join(p for p in (cond.get("grade"), cond.get("label")) if p) or "—"
    )
    value = escape_html(value_text(v.get("value") or {}) or "—")
    action = (
        escape_html(ACTION_LABEL[v["recommendedAction"]])
        if v.get("recommendedAction")
        else None
    )
    og_image = f'<meta property="og:image" content="{photo}">' if photo else ""
    card = "summary_large_image" if photo else "summary"
    photo_block = (
        f'<img class="photo" src="{photo}" alt="{title}">'
        if photo
        else '<div class="photo" role="img" aria-label="No photo"></div>'
    )
    action_block = f'<div class="action">{action}</div>' if action else ""
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>{title}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta property="og:url" content="{url}">
{og_image}
<meta name="twitter:card" content="{card}">
<style>
  :root{{--bg:#f5f6f8;--panel:#fff;--text:#16181d;--muted:#5f6673;--line:#e2e5ea;--accent:#2f6b3f}}
  @media (prefers-color-scheme:dark){{:root{{--bg:#111316;--panel:#1a1d22;--text:#e8eaee;--muted:#9aa2af;--line:#2b3038;--accent:#7fbf8e}}}}
  body{{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}}
  main{{max-width:480px;margin:0 auto;padding:24px 16px}}
  .card{{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}}
  .photo{{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;background:var(--line)}}
  .body{{padding:16px}}
  .brand{{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}}
  h1{{margin:4px 0 2px;font-size:24px}}
  .sub{{color:var(--muted);margin:0 0 14px}}
  .row{{display:grid;grid-template-columns:1fr 1fr;gap:12px;border-top:1px solid var(--line);padding-top:12px}}
  .k{{font-size:12px;color:var(--muted)}} .v{{font-weight:600}}
  .action{{margin-top:14px;padding:10px 12px;border-radius:10px;background:var(--accent);color:#fff;font-weight:600;text-align:center}}
  footer{{margin-top:16px;font-size:12px;color:var(--muted);text-align:center}}
</style>
</head>
<body>
<main>
  <article class="card">
    {photo_block}
    <div class="body">
      <div class="brand">{escape_html(v["brand"])}</div>
      <h1>{escape_html(v.get("model") or "")}</h1>
      <p class="sub">{sub}</p>
      <div class="row">
        <div><div class="k">Condition</div><div class="v">{condition}</div></div>
        <div><div class="k">Est. Resale Value</div><div class="v">{value}</div></div>
      </div>
      {action_block}
    </div>
  </article>
  <footer>Shared from S.H.O.E.S. by EarthDNA. Personal details stay private.</footer>
</main>
</body>
</html>
"""


NOT_FOUND_HTML = (
    '<!doctype html><meta charset="utf-8"><title>Not found</title>'
    '<p style="font:16px system-ui;padding:24px">This shoe profile is no longer shared.</p>'
)
