/*
 * Google Analytics 4 access for the GA Insights side panel.
 *
 * - Auth: Google Identity Services (GIS) OAuth 2.0 token model, browser only,
 *   scope analytics.readonly. No secrets are needed client-side; only a public
 *   OAuth Web Client ID whose "Authorized JavaScript origins" include the
 *   origin this panel is served from.
 * - Data: GA4 Data API v1beta (batchRunReports / runRealtimeReport).
 * - Admin: GA4 Admin API v1beta, used only to resolve a "G-XXXX" measurement ID
 *   (the tag) to the numeric property ID the Data API requires.
 */

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const DATA_API = 'https://analyticsdata.googleapis.com/v1beta';
const ADMIN_API = 'https://analyticsadmin.googleapis.com/v1beta';
const TOKEN_KEY = 'ga-insights:token';

/* ---------------------------------------------------------------- auth -- */

let gisPromise;
function loadGis() {
  gisPromise ??= new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) { resolve(); return; }
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gisPromise = undefined;
      reject(new Error('Could not load Google Identity Services'));
    };
    document.head.append(script);
  });
  return gisPromise;
}

function readStored() {
  try { return JSON.parse(sessionStorage.getItem(TOKEN_KEY)); } catch { return null; }
}

export function getCachedToken(clientId) {
  const stored = readStored();
  if (stored?.clientId === clientId && stored.expires > Date.now() + 60_000) return stored.value;
  return null;
}

function storeToken(clientId, value, expiresIn) {
  try {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify({
      clientId, value, expires: Date.now() + (Number(expiresIn) || 3600) * 1000,
    }));
  } catch { /* storage unavailable */ }
}

export function clearToken() {
  const token = readStored()?.value;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  if (token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(token);
}

/**
 * Opens the Google consent popup (must be called from a user gesture).
 * Resolves with an access token.
 */
export async function signIn(clientId) {
  if (!clientId) throw new Error('An OAuth Client ID is required. Add it in Settings.');
  await loadGis();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) {
          reject(new Error(resp.error_description || resp.error));
          return;
        }
        storeToken(clientId, resp.access_token, resp.expires_in);
        resolve(resp.access_token);
      },
      error_callback: (err) => {
        const msg = err?.type === 'popup_failed_to_open'
          ? 'The Google sign-in popup was blocked. Allow popups and try again.'
          : 'Google sign-in was cancelled.';
        reject(new Error(msg));
      },
    });
    client.requestAccessToken({ prompt: '' });
  });
}

/* ----------------------------------------------------------------- http -- */

export class GaError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function gaFetch(url, token, body) {
  let resp;
  try {
    resp = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new GaError(`Network error: ${e.message}`, 0);
  }
  if (!resp.ok) {
    let message = `Google Analytics request failed (${resp.status})`;
    try {
      const json = await resp.json();
      if (json.error?.message) message = json.error.message;
    } catch { /* not json */ }
    throw new GaError(message, resp.status);
  }
  return resp.json();
}

/* ------------------------------------------------------------- helpers -- */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Converts a GA report into [{ d: {dimName: value}, m: {metricName: number} }]. */
function rowsOf(report) {
  const dims = (report?.dimensionHeaders || []).map((h) => h.name);
  const mets = (report?.metricHeaders || []).map((h) => h.name);
  return (report?.rows || []).map((row) => ({
    d: Object.fromEntries(dims.map((n, i) => [n, row.dimensionValues?.[i]?.value])),
    m: Object.fromEntries(mets.map((n, i) => [n, num(row.metricValues?.[i]?.value)])),
  }));
}

const inList = (fieldName, values) => ({
  filter: { fieldName, inListFilter: { values, caseSensitive: false } },
});

const exact = (fieldName, value) => ({
  filter: { fieldName, stringFilter: { matchType: 'EXACT', value, caseSensitive: true } },
});

function and(...expressions) {
  const list = expressions.filter(Boolean);
  if (!list.length) return undefined;
  if (list.length === 1) return list[0];
  return { andGroup: { expressions: list } };
}

/** All the path spellings GA may have recorded for one EDS page. */
export function pathVariants(path) {
  if (!path || path === '/') return ['/', '/index', '/index.html'];
  const base = path.replace(/\/+$/, '');
  return [...new Set([base, `${base}/`, `${base}.html`])];
}

export function dateRanges(days) {
  return [
    { startDate: `${days - 1}daysAgo`, endDate: 'today', name: 'current' },
    { startDate: `${days * 2 - 1}daysAgo`, endDate: `${days}daysAgo`, name: 'previous' },
  ];
}

const KPI_METRICS = [
  'screenPageViews',
  'activeUsers',
  'newUsers',
  'userEngagementDuration',
  'engagementRate',
  'bounceRate',
  'scrolledUsers',
  'keyEvents',
];

const emptyKpis = () => Object.fromEntries(KPI_METRICS.map((m) => [m, 0]));

// With multiple date ranges GA adds a `dateRange` dimension holding the range name.
const rangeKey = (d) => (d.dateRange === 'previous' || d.dateRange === 'date_range_1' ? 'previous' : 'current');

function byRange(report) {
  const out = { current: emptyKpis(), previous: emptyKpis() };
  rowsOf(report).forEach(({ d, m }) => {
    const key = rangeKey(d);
    out[key] = { ...out[key], ...m };
  });
  return out;
}

const labelled = (report, dim, metric) => rowsOf(report)
  .map(({ d, m }) => ({ label: d[dim] || '(not set)', value: m[metric] }))
  .filter((r) => r.value > 0);

/* ------------------------------------------------------------- reports -- */

/**
 * Loads everything the panel needs for one page in two batch calls
 * (batchRunReports accepts at most 5 requests each).
 */
export async function loadPageReport({
  propertyId, token, path, hostnames = [], days = 28,
}) {
  const variants = pathVariants(path);
  const hostFilter = hostnames.length ? inList('hostName', hostnames) : undefined;
  const pageFilter = and(inList('pagePath', variants), hostFilter);
  const ranges = dateRanges(days);
  const [current] = ranges;
  const metrics = (names) => names.map((name) => ({ name }));
  const desc = (metricName) => [{ metric: { metricName }, desc: true }];

  const batchA = [
    { dateRanges: ranges, metrics: metrics(KPI_METRICS), dimensionFilter: pageFilter },
    { dateRanges: ranges, metrics: metrics(KPI_METRICS), dimensionFilter: hostFilter },
    {
      dateRanges: ranges,
      dimensions: [{ name: 'nthDay' }],
      metrics: metrics(['screenPageViews']),
      dimensionFilter: pageFilter,
      limit: 1000,
    },
    {
      dateRanges: [current],
      dimensions: [{ name: 'pagePath' }],
      metrics: metrics(['screenPageViews']),
      dimensionFilter: hostFilter,
      orderBys: desc('screenPageViews'),
      limit: 10000,
    },
    {
      dateRanges: [current],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: metrics(['screenPageViews']),
      dimensionFilter: pageFilter,
      orderBys: desc('screenPageViews'),
      limit: 8,
    },
  ];

  const batchB = [
    {
      dateRanges: [current],
      dimensions: [{ name: 'pageReferrer' }],
      metrics: metrics(['screenPageViews']),
      dimensionFilter: pageFilter,
      orderBys: desc('screenPageViews'),
      limit: 25,
    },
    {
      dateRanges: [current],
      dimensions: [{ name: 'deviceCategory' }],
      metrics: metrics(['screenPageViews']),
      dimensionFilter: pageFilter,
      orderBys: desc('screenPageViews'),
    },
    {
      dateRanges: [current],
      dimensions: [{ name: 'country' }],
      metrics: metrics(['activeUsers']),
      dimensionFilter: pageFilter,
      orderBys: desc('activeUsers'),
      limit: 6,
    },
    {
      dateRanges: [current],
      dimensions: [{ name: 'pageTitle' }],
      metrics: metrics(['screenPageViews']),
      dimensionFilter: pageFilter,
      orderBys: desc('screenPageViews'),
      limit: 1,
    },
    {
      dateRanges: [current],
      metrics: metrics(['sessions']),
      dimensionFilter: and(inList('landingPage', variants), hostFilter),
    },
  ];

  const url = `${DATA_API}/properties/${propertyId}:batchRunReports`;
  const [a, b] = await Promise.all([
    gaFetch(url, token, { requests: batchA }),
    gaFetch(url, token, { requests: batchB }),
  ]);
  const [pageR, siteR, trendR, topR, channelR] = a.reports || [];
  const [refR, deviceR, countryR, titleR, landingR] = b.reports || [];

  const trend = { current: new Array(days).fill(0), previous: new Array(days).fill(0) };
  rowsOf(trendR).forEach(({ d, m }) => {
    const i = parseInt(d.nthDay, 10);
    if (i >= 0 && i < days) trend[rangeKey(d)][i] += m.screenPageViews;
  });

  const topRows = rowsOf(topR);
  const lowerVariants = variants.map((v) => v.toLowerCase());
  const rankIndex = topRows
    .findIndex(({ d }) => lowerVariants.includes((d.pagePath || '').toLowerCase()));

  const ownHosts = hostnames.map((h) => h.toLowerCase());
  const referrers = labelled(refR, 'pageReferrer', 'screenPageViews')
    .map((r) => {
      try {
        const host = new URL(r.label).hostname.toLowerCase();
        return { ...r, host, label: host.replace(/^www\./, '') };
      } catch { return { ...r, host: '' }; }
    })
    .filter((r) => r.host && !ownHosts.includes(r.host))
    .reduce((acc, r) => {
      const hit = acc.find((x) => x.label === r.label);
      if (hit) hit.value += r.value; else acc.push({ label: r.label, value: r.value });
      return acc;
    }, [])
    .slice(0, 5);

  return {
    path,
    days,
    page: byRange(pageR),
    site: byRange(siteR),
    trend,
    rank: {
      position: rankIndex >= 0 ? rankIndex + 1 : null,
      total: num(topR?.rowCount) || topRows.length,
    },
    channels: labelled(channelR, 'sessionDefaultChannelGroup', 'screenPageViews'),
    referrers,
    devices: labelled(deviceR, 'deviceCategory', 'screenPageViews'),
    countries: labelled(countryR, 'country', 'activeUsers'),
    title: rowsOf(titleR)[0]?.d.pageTitle || '',
    entrances: rowsOf(landingR)[0]?.m.sessions || 0,
  };
}

/**
 * Realtime (last 30 minutes). The Realtime API has no page-path dimension;
 * for web streams `unifiedScreenName` is the page title, so we match on that.
 */
export async function loadRealtime({ propertyId, token, title }) {
  const url = `${DATA_API}/properties/${propertyId}:runRealtimeReport`;
  const metrics = [{ name: 'activeUsers' }, { name: 'screenPageViews' }];
  const pageFilter = title ? exact('unifiedScreenName', title) : null;

  const [siteR, pageR, minR, countryR] = await Promise.all([
    gaFetch(url, token, { metrics }),
    pageFilter && gaFetch(url, token, { metrics, dimensionFilter: pageFilter }),
    pageFilter && gaFetch(url, token, {
      dimensions: [{ name: 'minutesAgo' }],
      metrics: [{ name: 'screenPageViews' }],
      dimensionFilter: pageFilter,
      limit: 30,
    }),
    pageFilter && gaFetch(url, token, {
      dimensions: [{ name: 'country' }],
      metrics: [{ name: 'activeUsers' }],
      dimensionFilter: pageFilter,
      orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
      limit: 4,
    }),
  ]);

  const minutes = new Array(30).fill(0);
  rowsOf(minR).forEach(({ d, m }) => {
    const ago = parseInt(d.minutesAgo, 10);
    if (ago >= 0 && ago < 30) minutes[29 - ago] = m.screenPageViews;
  });
  return {
    matchedBy: title || null,
    siteActive: rowsOf(siteR)[0]?.m.activeUsers || 0,
    pageActive: rowsOf(pageR)[0]?.m.activeUsers || 0,
    pageViews: rowsOf(pageR)[0]?.m.screenPageViews || 0,
    minutes,
    countries: labelled(countryR, 'country', 'activeUsers'),
  };
}

/* --------------------------------------------------------------- admin -- */

/** Lists GA4 properties the signed-in user can read. */
export async function listProperties(token) {
  const out = [];
  let pageToken = '';
  do {
    const qs = `pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    // eslint-disable-next-line no-await-in-loop
    const json = await gaFetch(`${ADMIN_API}/accountSummaries?${qs}`, token);
    (json.accountSummaries || []).forEach((acct) => {
      (acct.propertySummaries || []).forEach((p) => {
        out.push({ id: p.property.split('/').pop(), name: p.displayName, account: acct.displayName });
      });
    });
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  return out;
}

/**
 * Returns the website URL (web stream default URI) of a GA4 property, preferring
 * the stream that matches the given measurement ID.
 */
export async function getPropertySiteUrl(token, propertyId, measurementId = '') {
  const json = await gaFetch(`${ADMIN_API}/properties/${propertyId}/dataStreams?pageSize=200`, token);
  const web = (json.dataStreams || []).filter((s) => s.webStreamData?.defaultUri);
  const wanted = measurementId.trim().toUpperCase();
  const stream = web.find((s) => s.webStreamData.measurementId?.toUpperCase() === wanted) || web[0];
  return stream?.webStreamData.defaultUri || '';
}

/** Resolves a "G-XXXXXXX" measurement ID (the tag) to its GA4 property. */
export async function findPropertyByMeasurementId(token, measurementId) {
  const wanted = measurementId.trim().toUpperCase();
  const properties = await listProperties(token);
  const results = await Promise.all(properties.map(async (p) => {
    try {
      const json = await gaFetch(`${ADMIN_API}/properties/${p.id}/dataStreams?pageSize=200`, token);
      const stream = (json.dataStreams || [])
        .find((s) => s.webStreamData?.measurementId?.toUpperCase() === wanted);
      return stream ? { ...p, defaultUri: stream.webStreamData.defaultUri } : null;
    } catch {
      return null;
    }
  }));
  return results.find(Boolean) || null;
}
