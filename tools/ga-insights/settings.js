/*
 * Persistent, site-wide settings for GA Insights.
 *
 * Settings are stored as a DA sheet (key/value rows) in the site's content:
 *   https://admin.da.live/source/{org}/{site}/tools/ga-insights/settings.json  (default)
 * so every author on the site shares one configuration, and admins can also
 * edit it in da.live like any other sheet. The location can be changed with a
 * `?config=/path/to/sheet.json` parameter on the library row's path.
 *
 * Values in the library row's query string (e.g. `?property=123&client=...`)
 * act as defaults underneath the saved sheet. localStorage is used as a
 * fallback when the sheet can't be read or written (e.g. standalone mode).
 */

const DA_SOURCE = 'https://admin.da.live/source';
export const DEFAULT_CONFIG_PATH = '/tools/ga-insights/settings.json';

export const DEFAULTS = {
  propertyId: '',
  measurementId: '',
  clientId: '',
  siteUrl: '',
  hostnames: '',
  pathPrefix: '',
  defaultDays: '28',
};

const PARAM_MAP = {
  property: 'propertyId',
  measurement: 'measurementId',
  client: 'clientId',
  url: 'siteUrl',
  hosts: 'hostnames',
  prefix: 'pathPrefix',
  days: 'defaultDays',
};

const localKey = (org, site) => `ga-insights:settings:${org || '_'}/${site || '_'}`;

function fromParams() {
  const params = new URLSearchParams(window.location.search);
  return Object.fromEntries(Object.entries(PARAM_MAP)
    .filter(([param]) => params.get(param))
    .map(([param, key]) => [key, params.get(param)]));
}

export function configPath() {
  const custom = new URLSearchParams(window.location.search).get('config');
  if (!custom) return DEFAULT_CONFIG_PATH;
  return custom.startsWith('/') ? custom : `/${custom}`;
}

function sheetToObject(json) {
  const rows = json?.data || json?.[json?.[':names']?.[0]]?.data || [];
  return Object.fromEntries(rows
    .map((row) => {
      const key = row.key ?? row.Key;
      const value = row.value ?? row.Value;
      return [key, value ?? ''];
    })
    .filter(([key]) => key && key in DEFAULTS));
}

function objectToSheet(settings) {
  const data = Object.keys(DEFAULTS).map((key) => ({ key, value: String(settings[key] ?? '') }));
  return {
    total: data.length, limit: data.length, offset: 0, data, ':type': 'sheet',
  };
}

function readLocal(org, site) {
  try { return JSON.parse(localStorage.getItem(localKey(org, site))) || {}; } catch { return {}; }
}

function writeLocal(org, site, settings) {
  try { localStorage.setItem(localKey(org, site), JSON.stringify(settings)); } catch { /* ignore */ }
}

/**
 * @returns {Promise<{settings: object, source: 'da'|'local'|'defaults', canWrite: boolean}>}
 */
export async function loadSettings({ org, site, daFetch }) {
  const base = { ...DEFAULTS, ...fromParams() };
  if (daFetch && org && site) {
    try {
      const resp = await daFetch(`${DA_SOURCE}/${org}/${site}${configPath()}`, { cache: 'no-store' });
      if (resp.ok) {
        const saved = sheetToObject(await resp.json());
        return {
          settings: { ...base, ...saved },
          source: 'da',
          canWrite: !resp.permissions || resp.permissions.includes('write'),
        };
      }
      if (resp.status === 404) {
        const local = readLocal(org, site);
        return {
          settings: { ...base, ...local },
          source: Object.keys(local).length ? 'local' : 'defaults',
          canWrite: true,
        };
      }
    } catch { /* fall through to local */ }
  }
  const local = readLocal(org, site);
  return {
    settings: { ...base, ...local },
    source: Object.keys(local).length ? 'local' : 'defaults',
    canWrite: true,
  };
}

/**
 * Saves to DA when connected (shared with all authors), always mirroring to
 * localStorage. Returns where it was persisted.
 */
export async function saveSettings({
  org, site, daFetch, settings,
}) {
  const clean = Object.fromEntries(Object.keys(DEFAULTS)
    .map((key) => [key, String(settings[key] ?? '').trim()]));
  writeLocal(org, site, clean);
  if (!daFetch || !org || !site) return { source: 'local', settings: clean };

  const body = new FormData();
  body.append('data', new Blob([JSON.stringify(objectToSheet(clean))], { type: 'application/json' }));
  const resp = await daFetch(`${DA_SOURCE}/${org}/${site}${configPath()}`, { method: 'POST', body });
  if (!resp.ok) {
    const reason = resp.status === 403
      ? 'You do not have permission to change this site\'s settings.'
      : `Could not save settings to DA (${resp.status}).`;
    const err = new Error(`${reason} Saved in this browser only.`);
    err.settings = clean;
    throw err;
  }
  return { source: 'da', settings: clean };
}

export function hostList(settings) {
  return String(settings.hostnames || '')
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean);
}
