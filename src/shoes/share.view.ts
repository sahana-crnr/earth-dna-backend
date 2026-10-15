// Public share view (E26, F5-D12/D13): what anyone with the link sees. No user
// data, no ids. The HTML variant is one static page with OpenGraph tags so a
// chat preview card shows the pair; no script, inline style only.
import type { RecommendedAction } from '../scan/scan.types';

export interface PublicShareView {
  brand: string;
  model: string | null;
  shoeType: string | null;
  color: string | null;
  condition: { grade: string | null; label: string | null };
  value: { min: number | null; max: number | null; currency: string };
  recommendedAction: RecommendedAction | null;
  /** Signed URL of the primary photo; null when none or signing failed. */
  photoUrl: string | null;
  sharedAt: string;
}

const ACTION_LABEL: Record<RecommendedAction, string> = {
  resell: 'Resell this pair',
  repair: 'Repair this pair',
  donate: 'Donate this pair',
  recycle: 'Recycle this pair',
};

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(v: number | null): string | null {
  if (v === null || !Number.isFinite(v)) return null;
  return Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`;
}

export function valueText(v: PublicShareView['value']): string | null {
  const min = money(v.min);
  const max = money(v.max);
  if (min && max) return `${min}–${max}`;
  return max ?? min;
}

/** Title line: "On Running Cloudmonster 2". */
export function shareTitle(v: PublicShareView): string {
  return [v.brand, v.model].filter(Boolean).join(' ');
}

/** Description line for og:description: condition + value. */
export function shareDescription(v: PublicShareView): string {
  const parts: string[] = [];
  if (v.condition.grade || v.condition.label) {
    parts.push(
      [v.condition.grade, v.condition.label].filter(Boolean).join(' · '),
    );
  }
  const value = valueText(v.value);
  if (value) parts.push(`Est. resale value ${value}`);
  return parts.join(' — ') || 'Shared from S.H.O.E.S. by EarthDNA';
}

export function renderShareHtml(v: PublicShareView, pageUrl: string): string {
  const title = escapeHtml(shareTitle(v));
  const description = escapeHtml(shareDescription(v));
  const url = escapeHtml(pageUrl);
  const photo = v.photoUrl ? escapeHtml(v.photoUrl) : null;
  const sub = escapeHtml(
    [v.shoeType, v.color].filter(Boolean).join(' · ') || '',
  );
  const condition = escapeHtml(
    [v.condition.grade, v.condition.label].filter(Boolean).join(' · ') || '—',
  );
  const value = escapeHtml(valueText(v.value) ?? '—');
  const action = v.recommendedAction
    ? escapeHtml(ACTION_LABEL[v.recommendedAction])
    : null;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${url}">
${photo ? `<meta property="og:image" content="${photo}">` : ''}
<meta name="twitter:card" content="${photo ? 'summary_large_image' : 'summary'}">
<style>
  :root{--bg:#f5f6f8;--panel:#fff;--text:#16181d;--muted:#5f6673;--line:#e2e5ea;--accent:#2f6b3f}
  @media (prefers-color-scheme:dark){:root{--bg:#111316;--panel:#1a1d22;--text:#e8eaee;--muted:#9aa2af;--line:#2b3038;--accent:#7fbf8e}}
  body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  main{max-width:480px;margin:0 auto;padding:24px 16px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}
  .photo{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;background:var(--line)}
  .body{padding:16px}
  .brand{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
  h1{margin:4px 0 2px;font-size:24px}
  .sub{color:var(--muted);margin:0 0 14px}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:12px;border-top:1px solid var(--line);padding-top:12px}
  .k{font-size:12px;color:var(--muted)} .v{font-weight:600}
  .action{margin-top:14px;padding:10px 12px;border-radius:10px;background:var(--accent);color:#fff;font-weight:600;text-align:center}
  footer{margin-top:16px;font-size:12px;color:var(--muted);text-align:center}
</style>
</head>
<body>
<main>
  <article class="card">
    ${photo ? `<img class="photo" src="${photo}" alt="${title}">` : '<div class="photo" role="img" aria-label="No photo"></div>'}
    <div class="body">
      <div class="brand">${escapeHtml(v.brand)}</div>
      <h1>${escapeHtml(v.model ?? '')}</h1>
      <p class="sub">${sub}</p>
      <div class="row">
        <div><div class="k">Condition</div><div class="v">${condition}</div></div>
        <div><div class="k">Est. Resale Value</div><div class="v">${value}</div></div>
      </div>
      ${action ? `<div class="action">${action}</div>` : ''}
    </div>
  </article>
  <footer>Shared from S.H.O.E.S. by EarthDNA. Personal details stay private.</footer>
</main>
</body>
</html>
`;
}
