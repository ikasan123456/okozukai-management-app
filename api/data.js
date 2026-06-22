// ============================================================================
// api/data.js
// ルール構造の更新版：type:'do' / type:'time_limit' に対応
// ============================================================================

const { kv } = require('@vercel/kv');

const CONFIG = {
  ACHIEVEMENT_DAYS_THRESHOLD: 7,
  CALENDAR_START_DAY: 0,
  UNDO_EXPIRY_MS: 300 * 60 * 1000,
  KV_KEY: 'okozukai_app_data',
};

function getDefaultData() {
  return { users: {}, rules: {}, points: {}, receivedCounts: {}, days: {}, extraHolidays: [], extraWeekdays: [], logs: [] };
}

const NOT_EXIST = '__NOT_EXIST__';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function dayKey(year, month, day) {
  return `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

function dayLabel(year, month, day) {
  return `${year}年${month+1}月${day}日`;
}

function getAtPath(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[key];
  }
  return cur;
}

function setAtPath(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (cur[key] === undefined || cur[key] === null) cur[key] = {};
    cur = cur[key];
  }
  cur[path[path.length - 1]] = value;
}

function deleteAtPath(obj, path) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (cur[key] === undefined) return;
    cur = cur[key];
  }
  delete cur[path[path.length - 1]];
}

function recordChanges(data, changes, description) {
  const snapshot = changes.map(({ path }) => {
    const prev = getAtPath(data, path);
    return { path, previousValue: prev === undefined ? NOT_EXIST : clone(prev) };
  });
  const now = Date.now();
  data.logs.push({
    id: generateId(),
    timestamp: now,
    expiresAt: now + CONFIG.UNDO_EXPIRY_MS,
    description,
    changes: snapshot,
  });
}

function purgeExpiredLogs(data) {
  const now = Date.now();
  const before = data.logs.length;
  data.logs = data.logs.filter((log) => log.expiresAt > now);
  return data.logs.length !== before;
}

async function loadData() {
  const raw = await kv.get(CONFIG.KV_KEY);
  if (!raw) return getDefaultData();
  const base = { ...getDefaultData(), ...raw };
  if (raw.preHolidays && !raw.extraHolidays) {
    base.extraHolidays = raw.preHolidays;
  }
  return base;
}

async function saveData(data) {
  await kv.set(CONFIG.KV_KEY, data);
}

function okResult(data, extra = {}) {
  return { status: 200, body: { ok: true, data, ...extra } };
}

function errorResult(message) {
  return { status: 400, body: { ok: false, error: message } };
}

function actionSaveUser(data, payload) {
  let { id, name, amount } = payload;
  name = String(name || '').trim();
  amount = Number(amount) || 0;

  if (!name) return errorResult('名前を入力してください');

  const isNew = !id;
  if (isNew) id = generateId();

  const changes = [{ path: ['users', id] }];
  if (isNew) {
    changes.push({ path: ['points', id] }, { path: ['rules', id] }, { path: ['receivedCounts', id] });
  }
  recordChanges(data, changes, `ユーザー「${name}」を${isNew ? '追加' : '更新'}`);

  const requiredDays = Math.max(7, Math.min(100, parseInt(payload.requiredDays) || 7));
  setAtPath(data, ['users', id], { id, name, amount, requiredDays });
  if (isNew) {
    setAtPath(data, ['points', id], 0);
    setAtPath(data, ['rules', id], { weekday: [], holiday: [] });
    setAtPath(data, ['receivedCounts', id], 0);
  }
  return okResult(data);
}

function actionDeleteUser(data, payload) {
  const { id } = payload;
  const user = getAtPath(data, ['users', id]);
  if (!user) return errorResult('対象のユーザーが見つかりません');

  const changes = [
    { path: ['users', id] },
    { path: ['rules', id] },
    { path: ['points', id] },
    { path: ['receivedCounts', id] },
  ];
  recordChanges(data, changes, `ユーザー「${user.name}」を削除`);

  deleteAtPath(data, ['users', id]);
  deleteAtPath(data, ['rules', id]);
  deleteAtPath(data, ['points', id]);
  deleteAtPath(data, ['receivedCounts', id]);
  return okResult(data);
}

function actionSaveRules(data, payload) {
  const { id, weekday, holiday } = payload;
  const user = getAtPath(data, ['users', id]);
  if (!user) return errorResult('対象のユーザーが見つかりません');

  recordChanges(data, [{ path: ['rules', id] }], `「${user.name}」のルールを更新`);
  setAtPath(data, ['rules', id], { 
    weekday: Array.isArray(weekday) ? weekday : [],
    holiday: Array.isArray(holiday) ? holiday : []
  });
  return okResult(data);
}

function actionSaveDay(data, payload) {
  const { userId, year, month, day, rules, memo, todos } = payload;
  const user = getAtPath(data, ['users', userId]);
  if (!user) return errorResult('対象のユーザーが見つかりません');

  const path = ['days', dayKey(year, month, day), userId];
  const existing = getAtPath(data, path) || {};
  const updated = { ...existing, rules: rules || [], memo: memo || '', todos: todos || existing.todos || [] };

  setAtPath(data, path, updated);
  return okResult(data);
}

function actionConfirmDay(data, payload) {
  const { userId, year, month, day, allSatisfied } = payload;
  const user = getAtPath(data, ['users', userId]);
  if (!user) return errorResult('対象のユーザーが見つかりません');

  const dayPath = ['days', dayKey(year, month, day), userId];
  const existing = getAtPath(data, dayPath) || {};
  if (existing.confirmed) return errorResult('この日はすでに確定済みです');

  const pointsPath = ['points', userId];
  recordChanges(
    data,
    [{ path: dayPath }, { path: pointsPath }],
    `「${user.name}」の${dayLabel(year, month, day)}を確定`
  );

  const now = Date.now();
  setAtPath(data, dayPath, { ...existing, confirmed: true, allSatisfied: Boolean(allSatisfied), confirmedAt: now });
  
  if (allSatisfied) {
    const currentPoints = getAtPath(data, pointsPath) || 0;
    const user = getAtPath(data, ['users', userId]);
    const maxPoints = (user && user.requiredDays ? user.requiredDays : 7) * 2;
    setAtPath(data, pointsPath, Math.min(currentPoints + 1, maxPoints));
  }
  return okResult(data);
}

function actionReceiveAllowance(data, payload) {
  const { userId, year, month, day } = payload;
  const user = getAtPath(data, ['users', userId]);
  if (!user) return errorResult('対象のユーザーが見つかりません');

  const requiredDays = user.requiredDays || CONFIG.ACHIEVEMENT_DAYS_THRESHOLD;
  const pointsPath = ['points', userId];
  const currentPoints = getAtPath(data, pointsPath) || 0;
  if (currentPoints < requiredDays) {
    return errorResult(`達成日数が${requiredDays}日に達していません`);
  }

  const dayPath = ['days', dayKey(year, month, day), userId];
  const existing = getAtPath(data, dayPath) || {};
  if (existing.received) return errorResult('この日はすでに受取済です');

  const receivedCountsPath = ['receivedCounts', userId];
  recordChanges(
    data,
    [{ path: dayPath }, { path: pointsPath }, { path: receivedCountsPath }],
    `「${user.name}」がおこづかいを受け取り`
  );

  const now = Date.now();
  setAtPath(data, dayPath, { ...existing, received: true, receivedAt: now, receivedDate: dayKey(year, month, day), receivedTime: new Date(now).toTimeString().slice(0,5) });
  setAtPath(data, pointsPath, currentPoints - requiredDays);
  setAtPath(data, receivedCountsPath, (getAtPath(data, receivedCountsPath) || 0) + 1);
  return okResult(data);
}

function toggleDateArray(data, arrayName, key, labelOn, labelOff) {
  if (!data[arrayName]) data[arrayName] = [];
  const idx = data[arrayName].indexOf(key);
  if (idx >= 0) {
    data[arrayName].splice(idx, 1);
    recordChanges(data, [], `${labelOff}「${key}」`);
  } else {
    data[arrayName].push(key);
    recordChanges(data, [], `${labelOn}「${key}」`);
  }
  return okResult(data);
}

function actionSaveExtraHoliday(data, payload) {
  return toggleDateArray(data, 'extraHolidays', payload.key, '休日設定', '休日設定を解除');
}

function actionSaveExtraWeekday(data, payload) {
  return toggleDateArray(data, 'extraWeekdays', payload.key, '平日設定', '平日設定を解除');
}

function actionUndo(data) {
  purgeExpiredLogs(data);
  if (data.logs.length === 0) return errorResult('取り消せる操作がありません');

  const log = data.logs[data.logs.length - 1];
  for (const change of log.changes) {
    if (change.previousValue === NOT_EXIST) {
      deleteAtPath(data, change.path);
    } else {
      setAtPath(data, change.path, change.previousValue);
    }
  }
  data.logs.pop();
  return okResult(data, { undone: log.description });
}

function handleAction(data, action, payload) {
  switch (action) {
    case 'saveUser':
      return actionSaveUser(data, payload);
    case 'deleteUser':
      return actionDeleteUser(data, payload);
    case 'saveRules':
      return actionSaveRules(data, payload);
    case 'saveDay':
      return actionSaveDay(data, payload);
    case 'confirmDay':
      return actionConfirmDay(data, payload);
    case 'receiveAllowance':
      return actionReceiveAllowance(data, payload);
    case 'saveExtraHoliday':
      return actionSaveExtraHoliday(data, payload);
    case 'saveExtraWeekday':
      return actionSaveExtraWeekday(data, payload);
    case 'undo':
      return actionUndo(data);
    default:
      return errorResult(`不明な操作です: ${action}`);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    const data = await loadData();
    const purged = purgeExpiredLogs(data);

    if (req.method === 'GET') {
      if (purged) await saveData(data);
      return res.status(200).json({ ok: true, data, config: CONFIG });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      const { action, payload } = body;
      const result = handleAction(data, action, payload || {});
      if (result.status === 200) {
        await saveData(data);
      }
      return res.status(result.status).json(result.body);
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message || 'Internal Server Error' });
  }
};
