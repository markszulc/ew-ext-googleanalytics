/* Synthetic data with the same shape as ga-api.js, used with `?demo`. */

function rand(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function hash(str) {
  return [...str].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 100000, 7);
}

export function demoPageReport(path, days) {
  const r = rand(hash(path) + days);
  const base = 40 + Math.round(r() * 160);
  const series = (scale) => Array.from({ length: days }, (_, i) => {
    const weekly = [0.7, 1, 1.1, 1.1, 1, 0.9, 0.6][i % 7];
    return Math.round(base * scale * weekly * (0.75 + r() * 0.5));
  });
  const current = series(1.15);
  const previous = series(1);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const kpis = (views, k) => ({
    screenPageViews: views,
    activeUsers: Math.round(views * 0.72 * k),
    newUsers: Math.round(views * 0.5 * k),
    userEngagementDuration: Math.round(views * 0.72 * 58 * k),
    engagementRate: 0.55 + r() * 0.15,
    bounceRate: 0.3 + r() * 0.15,
    scrolledUsers: Math.round(views * 0.72 * 0.38 * k),
    keyEvents: Math.round(views * 0.03 * k),
  });
  const pageViews = sum(current);
  const siteViews = pageViews * 37;
  return {
    path,
    days,
    page: { current: kpis(pageViews, 1), previous: kpis(sum(previous), 0.95) },
    site: { current: kpis(siteViews, 1.05), previous: kpis(Math.round(siteViews * 0.93), 1) },
    trend: { current, previous },
    rank: { position: 1 + Math.round(r() * 20), total: 214 },
    channels: [
      { label: 'Organic Search', value: Math.round(pageViews * 0.46) },
      { label: 'Direct', value: Math.round(pageViews * 0.24) },
      { label: 'Organic Social', value: Math.round(pageViews * 0.14) },
      { label: 'Referral', value: Math.round(pageViews * 0.09) },
      { label: 'Email', value: Math.round(pageViews * 0.07) },
    ],
    referrers: [
      { label: 'google.com', value: Math.round(pageViews * 0.31) },
      { label: 'linkedin.com', value: Math.round(pageViews * 0.08) },
      { label: 'bing.com', value: Math.round(pageViews * 0.05) },
      { label: 'reddit.com', value: Math.round(pageViews * 0.03) },
    ],
    devices: [
      { label: 'mobile', value: Math.round(pageViews * 0.63) },
      { label: 'desktop', value: Math.round(pageViews * 0.34) },
      { label: 'tablet', value: Math.round(pageViews * 0.03) },
    ],
    countries: [
      { label: 'United States', value: Math.round(pageViews * 0.3) },
      { label: 'Australia', value: Math.round(pageViews * 0.18) },
      { label: 'United Kingdom', value: Math.round(pageViews * 0.11) },
      { label: 'Germany', value: Math.round(pageViews * 0.07) },
      { label: 'Canada', value: Math.round(pageViews * 0.05) },
    ],
    title: demoTitle(path),
    entrances: Math.round(pageViews * 0.48),
  };
}

function demoTitle(path) {
  const slug = path.split('/').filter(Boolean).pop() || 'home';
  const name = slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return `${name} | Frescopa`;
}

export function demoRealtime(title) {
  const r = rand(Date.now() % 10000);
  const minutes = Array.from({ length: 30 }, () => (r() < 0.35 ? 0 : Math.round(r() * 5)));
  const pageActive = Math.max(1, Math.round(minutes.slice(-5).reduce((a, b) => a + b, 0) / 2));
  return {
    matchedBy: title,
    siteActive: pageActive * 9 + Math.round(r() * 20),
    pageActive,
    pageViews: minutes.reduce((a, b) => a + b, 0),
    minutes,
    countries: [
      { label: 'Australia', value: Math.ceil(pageActive * 0.5) },
      { label: 'United States', value: Math.ceil(pageActive * 0.3) },
    ],
  };
}
