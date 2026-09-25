const NOTION_VERSION = '2026-03-11';
const PUBLIC_ORIGIN = 'https://idaisei.github.io';

function doGet(event) {
  const app = event && event.parameter && event.parameter.app === 'tabi' ? 'tabi' : 'focus';
  const template = HtmlService.createTemplateFromFile('Index');
  template.appUrl = `${PUBLIC_ORIGIN}/tavi-web/${app}/?private=1`;
  template.appName = app === 'tabi' ? 'TAVI MAPS' : 'Focus Desk';
  return template.evaluate()
    .setTitle(template.appName)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function apiRequest(request) {
  const path = String(request && request.path || '');
  const method = String(request && request.method || 'GET').toUpperCase();
  const body = request && request.body;

  if (method === 'GET' && path === '/focus/sessions') {
    return { sessions: queryAll_(setting_('FOCUS_DATA_SOURCE_ID')).map(page => parseJson_(textOf_(page.properties['データ']))).filter(Boolean) };
  }
  if (method === 'POST' && path === '/focus/sessions') {
    if (!body || !body.session || !body.session.id) throw new Error('記録の形式が正しくありません');
    upsertFocus_(body);
    return { ok: true };
  }
  if (method === 'GET' && path === '/tavi/trips') {
    return { items: queryAll_(setting_('TAVI_DATA_SOURCE_ID')).map(page => parseJson_(textOf_(page.properties['データ']))).filter(Boolean) };
  }

  const match = path.match(/^\/tavi\/trips\/([^/]+)$/);
  if (match && (method === 'PUT' || method === 'DELETE')) {
    const id = decodeURIComponent(match[1]);
    const item = method === 'DELETE'
      ? { id, deleted: true, updatedAt: Number(body && body.updatedAt) || Date.now() }
      : Object.assign({}, body || {}, { id });
    if (!item.id || !Number.isFinite(Number(item.updatedAt))) throw new Error('旅程の形式が正しくありません');
    upsertTrip_(item);
    return { ok: true };
  }
  throw new Error('同期先が見つかりません');
}

function setting_(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) throw new Error(`${name} が未設定です`);
  return value;
}

function notion_(path, method, body) {
  const response = UrlFetchApp.fetch(`https://api.notion.com/v1${path}`, {
    method: String(method || 'get').toLowerCase(),
    headers: {
      Authorization: `Bearer ${setting_('NOTION_TOKEN')}`,
      'Notion-Version': NOTION_VERSION,
    },
    contentType: 'application/json',
    payload: body === undefined ? undefined : JSON.stringify(body),
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  const data = parseJson_(response.getContentText()) || {};
  if (status < 200 || status >= 300) throw new Error(`Notionとの接続に失敗しました（${status}）`);
  return data;
}

function queryAll_(dataSourceId) {
  const results = [];
  let cursor = null;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = notion_(`/data_sources/${dataSourceId}/query`, 'post', body);
    results.push.apply(results, data.results || []);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return results;
}

function findById_(dataSourceId, property, id) {
  const data = notion_(`/data_sources/${dataSourceId}/query`, 'post', {
    page_size: 1,
    filter: { property, rich_text: { equals: id } },
  });
  return data.results && data.results[0] || null;
}

function writePage_(dataSourceId, existing, properties) {
  if (existing) return notion_(`/pages/${existing.id}`, 'patch', { properties });
  return notion_('/pages', 'post', {
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties,
  });
}

function upsertFocus_(record) {
  const session = record.session;
  const subject = record.subject || {};
  const dataSourceId = setting_('FOCUS_DATA_SOURCE_ID');
  const existing = findById_(dataSourceId, 'セッションID', session.id);
  const breakMs = (session.breaks || []).reduce((sum, item) => sum + Math.max(0, (item.end || session.end) - item.start), 0);
  const studyMinutes = Math.max(0, (session.end - session.start - breakMs) / 60000);
  const label = subject.name || '学習';
  return writePage_(dataSourceId, existing, {
    '記録': title_(`${Utilities.formatDate(new Date(session.start), 'Asia/Tokyo', 'yyyy/MM/dd')} ${label}`),
    'セッションID': text_(session.id),
    '科目': text_(label),
    '開始': date_(session.start),
    '終了': date_(session.end),
    '勉強時間（分）': { number: Math.round(studyMinutes * 10) / 10 },
    '休憩時間（分）': { number: Math.round((breakMs / 60000) * 10) / 10 },
    'データ': text_(JSON.stringify(record)),
  });
}

function upsertTrip_(item) {
  const dataSourceId = setting_('TAVI_DATA_SOURCE_ID');
  const existing = findById_(dataSourceId, '旅程ID', item.id);
  return writePage_(dataSourceId, existing, {
    '旅程': title_(item.deleted ? '削除済み' : (item.title || '名称未設定の旅程')),
    '旅程ID': text_(item.id),
    '更新日時': date_(item.updatedAt),
    'データ': text_(JSON.stringify(item)),
  });
}

function text_(value) { return { rich_text: chunks_(value, 1900) }; }
function title_(value) { return { title: chunks_(value, 180) }; }
function date_(value) { return { date: { start: new Date(Number(value)).toISOString() } }; }

function chunks_(value, size) {
  const source = String(value == null ? '' : value);
  if (source.length > 150000) throw new Error('保存するデータが大きすぎます');
  const rows = source.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) || [''];
  return rows.map(content => ({ type: 'text', text: { content } }));
}

function textOf_(property) {
  const values = property && (property.rich_text || property.title) || [];
  return values.map(item => item.plain_text || item.text && item.text.content || '').join('');
}

function parseJson_(value) {
  try { return JSON.parse(value); } catch (error) { return null; }
}
