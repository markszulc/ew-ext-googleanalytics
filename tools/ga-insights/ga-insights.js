// eslint-disable-next-line import/no-unresolved
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import {
  signIn, getCachedToken, clearToken, loadPageReport, loadRealtime,
  listProperties, findPropertyByMeasurementId, getPropertySiteUrl, pathVariants,
} from './ga-api.js';
import {
  loadSettings, saveSettings, hostList, configPath,
} from './settings.js';
import { demoPageReport, demoRealtime } from './demo-data.js';
import './vendor/spectrum.js';

const params = new URLSearchParams(window.location.search);
const DEMO = params.has('demo');
const SDK_TIMEOUT_MS = 3000;
const REALTIME_MS = 60_000;
const RANGES = [7, 28, 90];
const DEMO_SITE_URL = 'https://www.example.com';

const app = document.querySelector('#app');

const state = {
  actions: null,
  org: '',
  site: '',
  daPath: '',
  pathOverride: params.get('path') || '',
  settings: {},
  settingsSource: 'defaults',
  canWrite: true,
  token: null,
  days: 28,
  view: 'loading',
  report: null,
  realtime: null,
  realtimeError: '',
  error: '',
  notice: '',
  properties: null,
  busy: false,
  invalidField: '',
  // Website URL read from the GA property's web stream: { propertyId, url }
  detectedSite: null,
};

let realtimeTimer;

/* ------------------------------------------------------------ formatting -- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const nf = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const fmtNum = (n) => (n < 10000 ? Math.round(n).toLocaleString() : nf.format(n));
const fmtPct = (r, digits = 0) => `${(r * 100).toFixed(digits)}%`;
const fmtDur = (sec) => {
  const s = Math.round(sec || 0);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};
const ratio = (a, b) => (b ? a / b : 0);
const change = (cur, prev) => (prev ? (cur - prev) / prev : null);

/* ------------------------------------------------------------------ path -- */

function toPublicPath(daPath) {
  let p = daPath || '/';
  const lead = `/${state.org}/${state.site}`;
  if (state.org && state.site && (p === lead || p.startsWith(`${lead}/`))) p = p.slice(lead.length) || '/';
  p = p.replace(/\.html$/, '');
  if (p === 'index' || p === '/index') p = '/';
  else if (p.endsWith('/index')) p = p.slice(0, -5);
  if (!p.startsWith('/')) p = `/${p}`;
  const prefix = (state.settings.pathPrefix || '').replace(/\/+$/, '');
  return `${prefix}${p}`.replace(/\/{2,}/g, '/');
}

const currentPath = () => state.pathOverride || toPublicPath(state.daPath);

function siteOrigin() {
  const { siteUrl, propertyId } = state.settings;
  const detected = propertyId && state.detectedSite?.propertyId === propertyId ? state.detectedSite.url : '';
  const host = hostList(state.settings)[0];
  const raw = siteUrl || detected || (host ? `https://${host}` : '') || (DEMO ? DEMO_SITE_URL : '');
  if (!raw) return '';
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).origin;
  } catch {
    return '';
  }
}

/** The page's full public URL, or just the path when the site URL is unknown. */
const pageUrl = (path) => `${siteOrigin()}${path}`;
const displayUrl = (path) => pageUrl(path).replace(/^https?:\/\//, '');

/* --------------------------------------------------------------- derived -- */

function kpis(m) {
  return {
    views: m.screenPageViews,
    users: m.activeUsers,
    newShare: ratio(m.newUsers, m.activeUsers),
    engagementTime: ratio(m.userEngagementDuration, m.activeUsers),
    engagementRate: m.engagementRate,
    bounceRate: m.bounceRate,
    scrollReach: ratio(m.scrolledUsers, m.activeUsers),
    keyEvents: m.keyEvents,
    keyEventRate: ratio(m.keyEvents, m.activeUsers),
  };
}

function buildInsights(report) {
  const page = kpis(report.page.current);
  const prev = kpis(report.page.previous);
  const site = kpis(report.site.current);
  const tips = [];
  if (page.views < 20) {
    tips.push({ tone: 'info', icon: 'info-circle', text: 'Not much traffic yet, so treat these numbers as early signals.' });
    return tips;
  }
  const viewsDelta = change(page.views, prev.views);
  if (viewsDelta !== null && viewsDelta >= 0.2) tips.push({ tone: 'good', icon: 'chart-trend', text: `Views are up ${fmtPct(viewsDelta)} on the previous ${report.days} days.` });
  if (viewsDelta !== null && viewsDelta <= -0.2) tips.push({ tone: 'warn', icon: 'alert-triangle', text: `Views are down ${fmtPct(-viewsDelta)} on the previous ${report.days} days. Is the content still current and linked from other pages?` });
  if (site.engagementTime && page.engagementTime < site.engagementTime * 0.7) {
    tips.push({ tone: 'warn', icon: 'clock', text: `People spend ${fmtDur(page.engagementTime)} here, against ${fmtDur(site.engagementTime)} across the site. A tighter intro, better headings or more visuals could hold attention.` });
  } else if (site.engagementTime && page.engagementTime > site.engagementTime * 1.3) {
    tips.push({ tone: 'good', icon: 'lightbulb', text: 'Readers spend more time here than on the average page. Link to it from weaker pages.' });
  }
  if (site.scrollReach && page.scrollReach < site.scrollReach * 0.75) {
    tips.push({ tone: 'warn', icon: 'align-bottom', text: `Only ${fmtPct(page.scrollReach)} of visitors reach the bottom (site: ${fmtPct(site.scrollReach)}). Move key messages and CTAs higher.` });
  }
  if (page.bounceRate > site.bounceRate + 0.1) {
    tips.push({ tone: 'warn', icon: 'undo', text: `The bounce rate is ${fmtPct(page.bounceRate)}, ${fmtPct(page.bounceRate - site.bounceRate)} points above the site. Add clear next steps or related links.` });
  }
  const totalDevice = report.devices.reduce((a, d) => a + d.value, 0);
  const mobile = report.devices.find((d) => d.label === 'mobile');
  if (mobile && ratio(mobile.value, totalDevice) >= 0.6) {
    tips.push({ tone: 'info', icon: 'device-phone', text: `${fmtPct(ratio(mobile.value, totalDevice))} of views are on mobile. Preview this page at mobile width before you publish.` });
  }
  const landingShare = ratio(report.entrances, page.views);
  if (landingShare >= 0.6) tips.push({ tone: 'info', icon: 'flag', text: `${fmtPct(landingShare)} of views are entrances, so most people land here first. Make the first screen count.` });
  if (!page.keyEvents && site.keyEvents) tips.push({ tone: 'info', icon: 'target', text: 'This page has no key events (conversions). Consider a clear call to action.' });
  const top = report.channels[0];
  if (top) tips.push({ tone: 'info', icon: 'discover', text: `${top.label} brings the most views (${fmtPct(ratio(top.value, page.views))}).` });
  return tips;
}

/* ---------------------------------------------------------------- charts -- */

function trendSvg({ current, previous }) {
  const w = 300;
  const h = 70;
  const max = Math.max(1, ...current, ...previous);
  const pts = (arr) => arr.map((v, i) => {
    const x = arr.length > 1 ? (i / (arr.length - 1)) * w : w / 2;
    const y = h - 4 - (v / max) * (h - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `
    <svg class="trend" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img"
      aria-label="Daily views, this period against the previous period">
      <polyline class="trend-prev" points="${pts(previous)}" />
      <polygon class="trend-area" points="0,${h} ${pts(current)} ${w},${h}" />
      <polyline class="trend-cur" points="${pts(current)}" />
    </svg>`;
}

function barList(items, total, fmt = fmtNum) {
  if (!items.length) return '<p class="muted">No data</p>';
  const max = Math.max(...items.map((i) => i.value));
  return `<ul class="bars">${items.map((i) => `
    <li>
      <span class="bar-label">${esc(i.label)}</span>
      <span class="bar-value">${fmt(i.value)}${total ? ` <small>${fmtPct(ratio(i.value, total))}</small>` : ''}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.max(2, ratio(i.value, max) * 100)}%"></span></span>
    </li>`).join('')}</ul>`;
}

function deviceSplit(devices) {
  const total = devices.reduce((a, d) => a + d.value, 0);
  if (!total) return '<p class="muted">No data</p>';
  const icon = { mobile: 'device-phone', desktop: 'device-desktop', tablet: 'device-tablet' };
  return `
    <div class="split" role="img" aria-label="Device split">
      ${devices.map((d) => `<span class="split-seg seg-${esc(d.label)}" style="flex:${d.value}"></span>`).join('')}
    </div>
    <ul class="legend">
      ${devices.map((d) => `<li><span class="dot seg-${esc(d.label)}"></span>${icon[d.label] ? `<sp-icon-${icon[d.label]} size="s"></sp-icon-${icon[d.label]}>` : ''} ${esc(d.label)} <strong>${fmtPct(ratio(d.value, total))}</strong></li>`).join('')}
    </ul>`;
}

/* ----------------------------------------------------------------- views -- */

function deltaBadge(cur, prev, { invert = false } = {}) {
  const c = change(cur, prev);
  if (c === null || !Number.isFinite(c)) return '<sp-badge size="s" variant="neutral">New</sp-badge>';
  if (Math.abs(c) < 0.005) return '<sp-badge size="s" variant="neutral">±0%</sp-badge>';
  const up = c > 0;
  const good = invert ? !up : up;
  return `<sp-badge size="s" variant="${good ? 'positive' : 'negative'}" title="vs previous period">${up ? '+' : '−'}${fmtPct(Math.abs(c))}</sp-badge>`;
}

function versus(pageVal, siteVal, fmt, { invert = false } = {}) {
  if (!siteVal) return '';
  const better = invert ? pageVal < siteVal : pageVal > siteVal;
  const close = Math.abs(ratio(pageVal - siteVal, siteVal)) < 0.05;
  const cls = close ? 'flat' : (better ? 'good' : 'bad');
  return `<span class="vs ${cls}">Site ${fmt(siteVal)}</span>`;
}

function kpiCard({
  label, value, delta = '', sub = '', hint = '',
}) {
  return `
    <div class="kpi" ${hint ? `title="${esc(hint)}"` : ''}>
      <span class="kpi-label">${label}</span>
      <span class="kpi-value">${value}</span>
      <span class="kpi-meta">${delta}${sub}</span>
    </div>`;
}

function realtimeHtml() {
  const rt = state.realtime;
  if (state.realtimeError) return `<p class="muted">Realtime unavailable: ${esc(state.realtimeError)}</p>`;
  if (!rt) return '<p class="muted">Loading live data…</p>';
  const max = Math.max(1, ...rt.minutes);
  return `
    <div class="live-head">
      <div>
        <span class="live-number">${fmtNum(rt.pageActive)}</span>
        <span class="live-label">${rt.pageActive === 1 ? 'person' : 'people'} on this page</span>
      </div>
      <div class="live-site">
        <strong>${fmtNum(rt.siteActive)}</strong> on the site
        ${rt.siteActive ? `<small>${fmtPct(ratio(rt.pageActive, rt.siteActive))} are here</small>` : ''}
      </div>
    </div>
    <div class="minutes" role="img" aria-label="Page views per minute, last 30 minutes">
      ${rt.minutes.map((v) => `<span style="height:${Math.max(4, ratio(v, max) * 100)}%" title="${v} views"></span>`).join('')}
    </div>
    <div class="minutes-axis"><span>30 min ago</span><span>now</span></div>
    ${rt.countries.length ? `<p class="live-countries">${rt.countries.map((c) => `${esc(c.label)} <strong>${c.value}</strong>`).join(' · ')}</p>` : ''}
    ${rt.matchedBy ? '' : '<p class="muted">Page title unknown, so only site-wide realtime is shown.</p>'}`;
}

function reportHtml() {
  const r = state.report;
  const page = kpis(r.page.current);
  const prev = kpis(r.page.previous);
  const site = kpis(r.site.current);
  const viewShare = ratio(page.views, site.views);

  if (!page.views && !prev.views) {
    return `
      <section class="card empty">
        <h2>No views recorded</h2>
        <p>GA has no page views for <code>${esc(displayUrl(r.path))}</code> in the last ${r.days} days.</p>
        <p class="muted">Paths checked: ${pathVariants(r.path).map((v) => `<code>${esc(v)}</code>`).join(' ')}
        ${hostList(state.settings).length ? `<br>Hostnames: ${hostList(state.settings).map(esc).join(', ')}` : ''}</p>
        <p class="muted">If the page is new or unpublished, this is expected. Otherwise check the path prefix and hostname settings.</p>
      </section>`;
  }

  const tips = buildInsights(r);
  const channelTotal = r.channels.reduce((a, c) => a + c.value, 0);
  const countryTotal = Math.max(page.users, r.countries.reduce((a, c) => a + c.value, 0));

  return `
    <section class="card live" aria-live="polite">
      <h2><span class="pulse" aria-hidden="true"></span> Right now <small>last 30 min</small></h2>
      <div id="realtime">${realtimeHtml()}</div>
    </section>

    <section class="card">
      <h2>Last ${r.days} days ${r.title ? `<small title="${esc(r.title)}">${esc(r.title)}</small>` : ''}</h2>
      <div class="kpis">
        ${kpiCard({
    label: 'Views',
    value: fmtNum(page.views),
    delta: deltaBadge(page.views, prev.views),
    sub: `<span class="vs">${fmtPct(viewShare, viewShare < 0.01 ? 2 : 1)} of site</span>`,
  })}
        ${kpiCard({
    label: 'Rank',
    value: r.rank.position ? `#${fmtNum(r.rank.position)}` : '—',
    sub: `<span class="vs">of ${fmtNum(r.rank.total)} pages</span>`,
    hint: 'Position among all pages by views in this period',
  })}
        ${kpiCard({
    label: 'Visitors',
    value: fmtNum(page.users),
    delta: deltaBadge(page.users, prev.users),
    sub: `<span class="vs">${fmtPct(page.newShare)} new</span>`,
  })}
        ${kpiCard({
    label: 'Avg. engaged time',
    value: fmtDur(page.engagementTime),
    delta: deltaBadge(page.engagementTime, prev.engagementTime),
    sub: versus(page.engagementTime, site.engagementTime, fmtDur),
    hint: 'Engaged time per visitor while the page was in the foreground',
  })}
        ${kpiCard({
    label: 'Engagement rate',
    value: fmtPct(page.engagementRate),
    delta: deltaBadge(page.engagementRate, prev.engagementRate),
    sub: versus(page.engagementRate, site.engagementRate, fmtPct),
    hint: 'Share of sessions lasting over 10s, with a key event, or with 2+ page views',
  })}
        ${kpiCard({
    label: 'Bounce rate',
    value: fmtPct(page.bounceRate),
    delta: deltaBadge(page.bounceRate, prev.bounceRate, { invert: true }),
    sub: versus(page.bounceRate, site.bounceRate, fmtPct, { invert: true }),
  })}
        ${kpiCard({
    label: 'Scrolled to end',
    value: fmtPct(page.scrollReach),
    delta: deltaBadge(page.scrollReach, prev.scrollReach),
    sub: versus(page.scrollReach, site.scrollReach, fmtPct),
    hint: 'Visitors who scrolled 90% of the page (needs enhanced measurement)',
  })}
        ${kpiCard({
    label: 'Key events',
    value: fmtNum(page.keyEvents),
    delta: deltaBadge(page.keyEvents, prev.keyEvents),
    sub: versus(page.keyEventRate, site.keyEventRate, (v) => `${(v * 100).toFixed(1)}/100`),
    hint: 'Conversions per 100 visitors, compared with the site',
  })}
      </div>
      <div class="trend-wrap">
        ${trendSvg(r.trend)}
        <p class="trend-legend"><span class="key cur"></span>Daily views <span class="key prev"></span>Previous ${r.days} days</p>
      </div>
    </section>

    ${tips.length ? `
    <section class="card">
      <h2>Author insights</h2>
      <ul class="tips">${tips.map((t) => `<li class="tip ${t.tone}"><sp-icon-${t.icon} aria-hidden="true"></sp-icon-${t.icon}><span>${esc(t.text)}</span></li>`).join('')}</ul>
    </section>` : ''}

    <section class="card">
      <h2>How people find it</h2>
      ${barList(r.channels.slice(0, 5), channelTotal)}
      ${r.referrers.length ? `<h3>Top referring sites</h3>${barList(r.referrers)}` : ''}
      <p class="muted small landing">${fmtPct(ratio(r.entrances, page.views))} of views start a visit (${fmtNum(r.entrances)} landings)</p>
    </section>

    <section class="card">
      <h2>Who's reading</h2>
      ${deviceSplit(r.devices)}
      <h3>Top countries</h3>
      ${barList(r.countries.slice(0, 5), countryTotal)}
    </section>`;
}

function field({
  id, name, label, value, help = '', required = false, attrs = '',
}) {
  const invalid = state.invalidField === name;
  return `
      <div class="field">
        <sp-field-label for="${id}" ${required ? 'required' : ''}>${label}</sp-field-label>
        <sp-textfield id="${id}" name="${name}" value="${esc(value)}" ${invalid ? 'invalid' : ''} ${attrs}>
          ${help ? `<sp-help-text slot="help-text">${help}</sp-help-text>` : ''}
          ${invalid ? `<sp-help-text slot="negative-help-text">${esc(state.error)}</sp-help-text>` : ''}
        </sp-textfield>
      </div>`;
}

function settingsHtml() {
  const s = state.settings;
  const where = state.actions
    ? `Saved for everyone on <strong>${esc(state.org)}/${esc(state.site)}</strong> in <code>${esc(configPath())}</code>.`
    : 'Not connected to Experience Workspace, so settings are saved in this browser only.';
  const props = state.properties;
  return `
    <form class="card settings" data-form="settings" novalidate>
      <h2>Settings</h2>
      <p class="muted small">${where}</p>

      <div class="field">
        <sp-field-label for="f-measurement">Google tag (measurement ID)</sp-field-label>
        <div class="row">
          <sp-textfield id="f-measurement" name="measurementId" value="${esc(s.measurementId)}" autocomplete="off">
            <sp-help-text slot="help-text">The <code>G-…</code> ID from your site's Google tag. GA reports can't be queried with it alone. <em>Find property</em> signs in and looks up the matching property ID. Leave it blank to list every property you can access.</sp-help-text>
          </sp-textfield>
          <sp-button variant="secondary" treatment="outline" data-action="find-property" ${state.busy ? 'pending' : ''}>Find property</sp-button>
        </div>
      </div>
      ${props ? `
      <div class="field">
        <sp-field-label for="f-pick">Your properties</sp-field-label>
        <sp-picker id="f-pick" data-action="pick-property" label="Choose a property" value="${esc(props.some((p) => p.id === s.propertyId) ? s.propertyId : '')}">
          ${props.map((p) => `<sp-menu-item value="${esc(p.id)}">${esc(p.name)} (${esc(p.id)}) · ${esc(p.account)}</sp-menu-item>`).join('')}
        </sp-picker>
      </div>` : ''}

      ${field({
    id: 'f-property', name: 'propertyId', label: 'GA4 property ID', value: s.propertyId, required: true, attrs: 'inputmode="numeric"', help: 'Numbers only, e.g. <code>123456789</code>. Find it in GA Admin → Property settings → Property details.',
  })}
      ${field({
    id: 'f-client', name: 'clientId', label: 'Google OAuth client ID', value: s.clientId, required: true, attrs: 'autocomplete="off"', help: `Ends in <code>.apps.googleusercontent.com</code>. A Web application OAuth client from Google Cloud with the Google Analytics Data API and Admin API enabled. Add <code>${esc(window.location.origin)}</code> to its Authorized JavaScript origins.`,
  })}
      ${field({
    id: 'f-site', name: 'siteUrl', label: 'Site URL', value: s.siteUrl, attrs: 'autocomplete="off"', help: `Shown in front of the page path. Leave it blank to use the website URL from the GA property's web stream${state.detectedSite?.url && s.propertyId && state.detectedSite.propertyId === s.propertyId ? ` (currently <code>${esc(state.detectedSite.url)}</code>)` : ''}.`,
  })}
      ${field({
    id: 'f-hosts', name: 'hostnames', label: 'Hostnames to include', value: s.hostnames, help: 'Comma-separated, e.g. <code>www.example.com</code>. Use this to leave out aem.page and aem.live preview traffic. Leave it blank to count every host.',
  })}
      ${field({
    id: 'f-prefix', name: 'pathPrefix', label: 'Path prefix', value: s.pathPrefix, help: 'For example <code>/en</code>. Added in front of the page path, for when the live site serves this content under a sub-path.',
  })}

      <div class="field">
        <sp-field-label for="f-days">Default date range</sp-field-label>
        <sp-picker id="f-days" name="defaultDays" label="Default date range" value="${esc(String(s.defaultDays || 28))}">
          ${RANGES.map((d) => `<sp-menu-item value="${d}">Last ${d} days</sp-menu-item>`).join('')}
        </sp-picker>
      </div>

      <div class="actions">
        ${state.report || state.view === 'signin' ? '<sp-button variant="secondary" treatment="outline" data-action="close-settings">Cancel</sp-button>' : ''}
        <sp-button variant="accent" data-action="save" ${state.canWrite ? '' : 'disabled'}>Save</sp-button>
      </div>
      ${state.canWrite ? '' : '<p class="muted small">You can only read this site\'s settings.</p>'}
      ${state.token ? '<sp-action-button class="signout" quiet size="s" data-action="sign-out">Sign out of Google</sp-action-button>' : ''}
    </form>`;
}

function signinHtml() {
  return `
    <section class="card center">
      <div class="hero" aria-hidden="true"><sp-icon-chart-trend size="l"></sp-icon-chart-trend></div>
      <h2>Connect Google Analytics</h2>
      <p>Sign in with a Google account that has at least <strong>Viewer</strong> access to GA4 property <code>${esc(state.settings.propertyId)}</code>.</p>
      <sp-button variant="accent" data-action="sign-in" ${state.busy ? 'pending' : ''}>Sign in with Google</sp-button>
      <p class="muted small">Read-only access. Your token is kept in this browser tab only.</p>
    </section>`;
}

const banner = (tone, icon, html, role = '') => `
    <div class="banner ${tone}" ${role ? `role="${role}"` : ''}><sp-icon-${icon} size="s"></sp-icon-${icon}><span>${html}</span></div>`;

function headerHtml() {
  const path = currentPath();
  const showControls = state.view === 'report' || state.view === 'loading-report';
  return `
    <header class="top">
      <div class="title">
        <h1><img class="logo" src="ga-logo.svg" alt="" width="24" height="24">Google Analytics</h1>
        <button type="button" class="path" data-action="edit-path" title="${esc(pageUrl(path))}. Click to change the page path to analyse."><span>${esc(displayUrl(path))}</span><sp-icon-edit size="xs"></sp-icon-edit></button>
      </div>
      <div class="tools">
        ${showControls ? '<sp-action-button quiet size="m" data-action="refresh" label="Refresh"><sp-icon-refresh slot="icon"></sp-icon-refresh></sp-action-button>' : ''}
        <sp-action-button quiet size="m" data-action="settings" label="Settings" ${state.view === 'settings' ? 'selected' : ''}><sp-icon-settings slot="icon"></sp-icon-settings></sp-action-button>
      </div>
    </header>
    ${showControls ? `
    <div class="subbar">
      <sp-action-group compact size="s" selects="single" data-action="days" label="Date range">
        ${RANGES.map((d) => `<sp-action-button value="${d}" ${d === state.days ? 'selected' : ''}>${d} days</sp-action-button>`).join('')}
      </sp-action-group>
    </div>` : ''}
    ${DEMO ? banner('info', 'info-circle', 'Demo mode: showing synthetic data.') : ''}
    ${!state.actions && !DEMO ? banner('info', 'info-circle', 'Not connected to Experience Workspace. Running standalone.') : ''}
    ${state.notice ? banner('good', 'checkmark-circle', esc(state.notice), 'status') : ''}
    ${state.error && !state.invalidField ? banner('error', 'alert-triangle', esc(state.error), 'alert') : ''}`;
}

const spinner = (label) => `<div class="loading"><sp-progress-circle indeterminate size="l" label="${label}"></sp-progress-circle><span>${label}</span></div>`;

function render() {
  let body = '';
  if (state.view === 'loading') body = spinner('Connecting…');
  else if (state.view === 'settings') body = settingsHtml();
  else if (state.view === 'signin') body = signinHtml();
  else if (state.view === 'loading-report') body = spinner('Loading analytics…');
  else if (state.view === 'report' && state.report) body = reportHtml();
  app.innerHTML = headerHtml() + body;
}

function renderRealtime() {
  const el = document.querySelector('#realtime');
  if (el) el.innerHTML = realtimeHtml();
}

/* ---------------------------------------------------------------- data -- */

const isConfigured = () => DEMO || (state.settings.propertyId && state.settings.clientId);

async function refreshRealtime() {
  if (!state.report || document.visibilityState !== 'visible') return;
  try {
    state.realtime = DEMO
      ? demoRealtime(state.report.title)
      : await loadRealtime({
        propertyId: state.settings.propertyId, token: state.token, title: state.report.title,
      });
    state.realtimeError = '';
  } catch (e) {
    state.realtimeError = e.message;
    if (e.status === 401) { stopRealtime(); clearToken(); state.token = null; }
  }
  renderRealtime();
}

function stopRealtime() {
  clearInterval(realtimeTimer);
  realtimeTimer = undefined;
}

function startRealtime() {
  stopRealtime();
  refreshRealtime();
  realtimeTimer = setInterval(refreshRealtime, REALTIME_MS);
}

async function detectSite() {
  const { propertyId, siteUrl, measurementId } = state.settings;
  if (DEMO || siteUrl || !propertyId || state.detectedSite?.propertyId === propertyId) return;
  try {
    const url = await getPropertySiteUrl(state.token, propertyId, measurementId);
    state.detectedSite = { propertyId, url };
  } catch {
    // Optional: needs the Admin API. Without it the header shows the path only.
    state.detectedSite = { propertyId, url: '' };
  }
}

async function loadReport() {
  state.error = '';
  if (!isConfigured()) { state.view = 'settings'; render(); return; }
  if (!DEMO && !state.token) { state.view = 'signin'; render(); return; }
  stopRealtime();
  state.view = 'loading-report';
  state.realtime = null;
  render();
  try {
    const [report] = await Promise.all([
      DEMO
        ? demoPageReport(currentPath(), state.days)
        : loadPageReport({
          propertyId: state.settings.propertyId,
          token: state.token,
          path: currentPath(),
          hostnames: hostList(state.settings),
          days: state.days,
        }),
      detectSite(),
    ]);
    state.report = report;
    state.view = 'report';
    render();
    startRealtime();
  } catch (e) {
    state.report = null;
    if (e.status === 401) {
      clearToken();
      state.token = null;
      state.view = 'signin';
      state.error = 'Your Google session expired. Please sign in again.';
    } else if (e.status === 403) {
      state.view = 'settings';
      state.error = `This Google account can't read property ${state.settings.propertyId}. Ask a GA admin for Viewer access, or check that the Analytics Data API is enabled. (${e.message})`;
    } else {
      state.view = 'settings';
      state.error = e.message;
    }
    render();
  }
}

async function ensureToken() {
  if (state.token) return state.token;
  state.token = await signIn(state.settings.clientId);
  return state.token;
}

/* -------------------------------------------------------------- actions -- */

function readForm(form) {
  const data = Object.fromEntries([...form.querySelectorAll('[name]')]
    .map((el) => [el.getAttribute('name'), String(el.value ?? '').trim()]));
  return { ...state.settings, ...data };
}

async function onFindProperty(form) {
  const draft = readForm(form);
  state.settings = draft;
  state.error = '';
  state.invalidField = '';
  state.notice = '';
  if (!draft.clientId) {
    state.error = 'Enter the OAuth client ID first. Finding the property needs a Google sign-in.';
    render();
    return;
  }
  state.busy = true;
  render();
  try {
    const token = await ensureToken();
    if (draft.measurementId) {
      const found = await findPropertyByMeasurementId(token, draft.measurementId);
      if (found) {
        state.settings = { ...draft, propertyId: found.id };
        if (found.defaultUri) state.detectedSite = { propertyId: found.id, url: found.defaultUri };
        state.notice = `Found "${found.name}" (${found.id})${found.defaultUri ? ` for ${found.defaultUri}` : ''}.`;
      } else {
        state.error = `None of your GA4 properties has a web stream with ${draft.measurementId}.`;
        state.properties = await listProperties(token);
      }
    } else {
      state.properties = await listProperties(token);
      if (!state.properties.length) state.error = 'This Google account has no GA4 properties.';
    }
  } catch (e) {
    state.error = e.message;
  }
  state.busy = false;
  render();
}

async function onSave(form) {
  const draft = readForm(form);
  state.error = '';
  state.notice = '';
  state.invalidField = '';
  if (!/^\d+$/.test(String(draft.propertyId).trim())) {
    state.settings = draft;
    state.invalidField = 'propertyId';
    state.error = /^G-/i.test(draft.propertyId)
      ? 'That looks like a measurement ID (G-…). Put it in the Google tag field and use Find property.'
      : 'The property ID must contain numbers only.';
    render();
    return;
  }
  if (!String(draft.clientId).trim()) {
    state.settings = draft;
    state.invalidField = 'clientId';
    state.error = 'The OAuth client ID is required.';
    render();
    return;
  }
  const clientChanged = draft.clientId !== state.settings.clientId;
  try {
    const saved = await saveSettings({
      org: state.org, site: state.site, daFetch: state.actions?.daFetch, settings: draft,
    });
    state.settings = saved.settings;
    state.settingsSource = saved.source;
    state.notice = saved.source === 'da' ? 'Settings saved for this site.' : 'Settings saved in this browser.';
  } catch (e) {
    state.settings = e.settings || draft;
    state.error = e.message;
  }
  if (clientChanged) state.token = getCachedToken(state.settings.clientId);
  state.days = Number(state.settings.defaultDays) || 28;
  await loadReport();
}

app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.matches('sp-picker, sp-action-group') || el.disabled) return;
  const { action } = el.dataset;
  if (action !== 'save') state.invalidField = '';
  if (action === 'save') {
    onSave(el.closest('form'));
  } else if (action === 'settings') {
    stopRealtime();
    state.error = '';
    state.notice = '';
    state.view = 'settings';
    render();
  } else if (action === 'close-settings') {
    state.error = '';
    if (state.report) { state.view = 'report'; render(); startRealtime(); } else loadReport();
  } else if (action === 'refresh') {
    state.notice = '';
    loadReport();
  } else if (action === 'sign-in') {
    state.busy = true;
    state.error = '';
    render();
    try {
      await ensureToken();
      state.busy = false;
      loadReport();
    } catch (err) {
      state.busy = false;
      state.error = err.message;
      render();
    }
  } else if (action === 'sign-out') {
    clearToken();
    state.token = null;
    state.notice = 'Signed out of Google.';
    render();
  } else if (action === 'find-property') {
    onFindProperty(el.closest('form'));
  } else if (action === 'edit-path') {
    // eslint-disable-next-line no-alert
    const next = window.prompt('Page path to analyse (as recorded in GA):', currentPath());
    if (next === null) return;
    const trimmed = next.trim();
    state.pathOverride = trimmed && trimmed !== toPublicPath(state.daPath) ? trimmed : '';
    loadReport();
  }
});

app.addEventListener('change', (e) => {
  const { action } = e.target.dataset;
  if (action === 'days') {
    const days = Number(e.target.selected?.[0]);
    if (days && days !== state.days) { state.days = days; loadReport(); }
  } else if (action === 'pick-property' && e.target.value) {
    const input = app.querySelector('#f-property');
    if (input) input.value = e.target.value;
  }
});

app.addEventListener('submit', (e) => {
  e.preventDefault();
  if (e.target.dataset.form === 'settings') onSave(e.target);
});

app.addEventListener('keydown', (e) => {
  const form = e.target.closest?.('form[data-form="settings"]');
  if (form && e.key === 'Enter' && e.target.matches('sp-textfield')) {
    e.preventDefault();
    onSave(form);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && realtimeTimer) refreshRealtime();
});

/* ------------------------------------------------------------------ init -- */

(async function init() {
  render();
  const sdk = await Promise.race([
    DA_SDK,
    new Promise((resolve) => { setTimeout(() => resolve(null), SDK_TIMEOUT_MS); }),
  ]);
  if (sdk) {
    const { context = {}, actions } = sdk;
    state.actions = actions;
    state.org = context.org || '';
    state.site = context.site || context.repo || '';
    state.daPath = context.path || '';
  } else {
    state.org = params.get('org') || '';
    state.site = params.get('site') || '';
  }

  const loaded = await loadSettings({
    org: state.org, site: state.site, daFetch: state.actions?.daFetch,
  });
  state.settings = loaded.settings;
  state.settingsSource = loaded.source;
  state.canWrite = loaded.canWrite;
  state.days = Number(state.settings.defaultDays) || 28;
  state.token = getCachedToken(state.settings.clientId);
  loadReport();
}());
