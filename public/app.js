let csrf = null;
const $ = id => document.getElementById(id);
const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '--';
const fmt = (value, unit = '') => value === null || value === undefined ? '--' : `${value}${unit}`;
const remaining = minutes => minutes === null || minutes === undefined ? '车辆未上报'
  : minutes < 60 ? `约 ${minutes} 分钟` : `约 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
const renewal = event => !event ? '尚未发生'
  : `${date(event.at)} · ${event.kind === 'gateway' ? '网关' : '旧会话'} · ${event.ok ? '成功' : `失败（${event.code || 'ERROR'}）`}`;
async function api(path, method = 'GET', payload) {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: {
    ...(payload ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-harbor-csrf': csrf } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '请求失败');
  return value;
}
const message = (id, content) => { $(id).textContent = content || ''; };
async function load() {
  try {
    if (!csrf) csrf = (await api('/api/session')).csrf;
    $('loginPanel').hidden = true; $('dashboard').hidden = false; $('logout').hidden = false;
    const state = await api('/api/state');
    const s = state.status;
    $('connection').textContent = state.connected ? '车辆已接入' : '等待车辆接入';
    $('vehicle').textContent = state.vehicle || '零跑 C11';
    $('soc').textContent = fmt(s?.soc);
    $('range').textContent = fmt(s?.range, ' km');
    $('mileage').textContent = fmt(s?.mileage, ' km');
    $('lock').textContent = s?.locked === null || s?.locked === undefined ? '未知' : s.locked ? '已锁车' : '未锁车';
    $('ac').textContent = s?.ac === null || s?.ac === undefined ? '未知' : s.ac ? '已开启' : '已关闭';
    $('drive').textContent = s ? s.driving ? '车辆行驶中' : '车辆未行驶' : '行驶状态 --';
    $('interiorTemperature').textContent = fmt(s?.interiorTemperature, ' ℃');
    const charge = s?.charging;
    $('chargeStatus').textContent = charge?.label || '暂无充电数据';
    $('chargeStatus').classList.toggle('warning', charge?.state === 3);
    $('chargeType').textContent = charge?.type || '充电类型未上报';
    $('chargePower').textContent = charge?.powerKw === null || charge?.powerKw === undefined ? '-- kW' : `${charge.powerKw.toFixed(1)} kW`;
    $('chargeRemaining').textContent = charge?.state === 2 ? '充电完成' : charge?.isCharging ? remaining(charge.remainingMinutes) : '--';
    $('chargeFinishAt').textContent = charge?.estimatedFinishAt ? new Date(charge.estimatedFinishAt).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '--';
    $('tires').replaceChildren(...(s?.tires?.length ? s.tires : ['左前', '右前', '左后', '右后'].map(label => ({ label }))).map(tire => {
      const cell = document.createElement('div'); cell.className = 'tire';
      cell.classList.toggle('warning', tire.warning === true);
      const label = document.createElement('span'); label.textContent = tire.label;
      const pressure = document.createElement('b'); pressure.textContent = fmt(tire.pressureKpa);
      const state = document.createElement('small'); state.textContent = tire.warning === true ? '车端异常提示'
        : tire.pressureKpa === null || tire.pressureKpa === undefined ? '未上报' : 'kPa';
      cell.append(label, pressure, state); return cell;
    }));
    const health = state.authHealth || {};
    $('appVersion').textContent = `v${state.version || '--'}${state.revision ? ` · ${state.revision.slice(0, 7)}` : ''}`;
    $('lastSuccessfulPoll').textContent = date(health.lastSuccessfulPollAt);
    $('lastRenewal').textContent = renewal(health.lastRenewal);
    $('lastSuccessfulRenewal').textContent = renewal(health.lastSuccessfulRenewal);
    $('gatewayExpiry').textContent = date(health.gatewayExpiresAt);
    $('renewalCounts').textContent = `网关 ${health.gatewayRenewals || 0} 次 · 旧会话 ${health.legacyRenewals || 0} 次`;
    const diagnostic = health.lastReadDiagnostics;
    const diagnosticLabels = { soc: '电量', range: '续航', mileage: '里程', speed: '速度', gear: '挡位',
      driving: '行驶状态', locked: '锁车状态', ac: '空调状态', interiorTemperature: '车内温度',
      tires: '胎压', charging: '充电信息', position: '位置' };
    const saveReasons = { saved: '已保存新采样', same_timestamp: '未保存：车端时间戳相同',
      older_timestamp: '未保存：车端时间戳更早', not_saved: '未保存：需检查' };
    $('diagQuery').textContent = diagnostic ? date(diagnostic.queriedAt) : '等待新版首次读取';
    $('diagReported').textContent = diagnostic ? diagnostic.timestampMissing ? '时间缺失或无效（不能认定为新上报）' : date(diagnostic.reportedAt) : '--';
    $('diagPrevious').textContent = date(diagnostic?.previousReportedAt);
    $('diagSaved').textContent = diagnostic ? `${saveReasons[diagnostic.reason] || '未知'}${diagnostic.timestampMissing ? '；当前归一化时间使用接收时间' : ''}` : '--';
    $('diagChanges').textContent = diagnostic ? diagnostic.previousReportedAt === null ? '首次采样，无对比基准'
      : diagnostic.changedFields.length ? diagnostic.changedFields.map(field => diagnosticLabels[field] || '未知字段').join('、') : '无变化' : '--';
    $('diagTimes').textContent = diagnostic ? diagnostic.timestampCandidates.map(item => `${item.field}.sts：${date(item.time)}`).join('；') : '--';
    $('position').textContent = s?.position ? `坐标 ${s.position.latitude.toFixed(5)}, ${s.position.longitude.toFixed(5)}` : '暂无可用坐标';
    if (s?.position) {
      const locationTime = s.sourceTime;
      api('/api/address').then(value => {
        if (value.address && value.sourceTime === locationTime) $('position').textContent = value.address;
      }).catch(() => {});
    }
    const age = s ? Math.round((Date.now() - s.sourceTime) / 60000) : null;
    $('freshness').textContent = age === null ? '暂无车况' : s.stale || age > 10 ? age > 10 ? `旧数据 · ${age} 分钟前` : '车端时间待核对' : '车况已更新';
    $('updated').textContent = s ? `车辆上报 ${date(s.sourceTime)} · 收到于 ${date(s.receivedAt)}` : '尚未取得车况';
    $('controlState').textContent = state.lastCommand ? `${state.lastCommand.status} · ${state.lastCommand.message}` : state.controlEnabled ? '操作需要四位车辆操作密码' : '控制功能默认关闭，完成只读验证后可在 NAS 上开启。';
    $('climateButton').disabled = !state.controlEnabled || !state.connected;
    $('setup').hidden = state.connected; $('disconnect').hidden = !state.connected;
    $('pairSetup').hidden = state.connected;
    if (state.lastError) $('connection').textContent = `需检查 · ${state.lastError}`;
    const journal = await api('/api/trips');
    $('days').replaceChildren(...journal.days.map(day => {
      const div = document.createElement('div'); div.className = 'day';
      const title = document.createElement('span'); title.textContent = day.day;
      const distance = document.createElement('b'); distance.textContent = fmt(day.distanceKm, ' km');
      div.append(title, distance); return div;
    }));
    $('trips').replaceChildren(...journal.trips.map(trip => {
      const row = document.createElement('div'); row.className = 'trip';
      const detail = document.createElement('div'); detail.textContent = `${date(trip.startedAt)} → ${date(trip.endedAt)}`;
      const small = document.createElement('small'); small.textContent = `${trip.quality} · 电量 ${fmt(trip.startSoc, '%')} → ${fmt(trip.endSoc, '%')}`;
      detail.append(small); const distance = document.createElement('b'); distance.textContent = fmt(trip.distanceKm, ' km');
      row.append(detail, distance); return row;
    }));
    if (!journal.trips.length) message('trips', '还没有完整的行程。采集一段时间后会自动生成。');
  } catch (error) {
    if (error.message.includes('请登录')) { csrf = null; $('loginPanel').hidden = false; $('dashboard').hidden = true; $('logout').hidden = true; }
    else message('setupMessage', error.message);
  }
}
async function submit(id, callback, output = 'setupMessage') {
  $(id).addEventListener('submit', async event => { event.preventDefault(); message(output, '正在处理…');
    try { await callback(); message(output, '已完成'); await load(); }
    catch (error) { message(output, error.message); }
  });
}
submit('loginForm', async () => {
  const value = await api('/api/login', 'POST', { password: $('password').value });
  csrf = value.csrf; $('password').value = '';
}, 'loginError');
submit('smsForm', async () => api('/api/vehicle/sms', 'POST', { phone: $('phone').value }));
submit('vehicleLoginForm', async () => api('/api/vehicle/login', 'POST', { phone: $('phone').value,
  smsCode: $('smsCode').value, smDeviceId: $('smId').value }));
submit('importForm', async () => api('/api/vehicle/import', 'POST', JSON.parse($('sessionJson').value)));
$('pairStart').addEventListener('click', async () => {
  try {
    const result = await api('/api/pair/start', 'POST');
    $('pairInfo').textContent = `在零跑智控「我的 → 配对 NAS」输入地址 ${result.url} 和配对码 ${result.code}。5 分钟内有效，仅可使用一次。`;
  } catch (error) { message('pairInfo', error.message); }
});
$('importFile').addEventListener('click', async () => {
  message('importFileInfo', '正在验证登录文件…');
  try {
    await api('/api/vehicle/import-file', 'POST');
    message('importFileInfo', '导入成功，请删除 import 文件夹中的明文登录文件。');
    await load();
  } catch (error) { message('importFileInfo', error.message); }
});
submit('climateForm', async () => {
  if (!confirm(`确认开启车辆空调，设为 ${$('temp').value}℃？`)) { message('controlState', '已取消'); return; }
  const result = await api('/api/climate', 'POST', { action: 'on', temperature: Number($('temp').value), pin: $('pin').value,
    confirm: '执行空调指令' });
  $('pin').value = '';
  for (let i = 0; i < 24; i++) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const state = await api(`/api/commands/${result.id}`);
    message('controlState', `${state.status} · ${state.message}`);
    if (state.status !== '处理中') break;
  }
  await load();
}, 'controlState');
$('refresh').addEventListener('click', async () => { message('updated', '正在刷新…'); try { await api('/api/refresh', 'POST'); await load(); } catch (e) { message('updated', e.message); } });
$('disconnect').addEventListener('click', async () => { if (!confirm('断开车辆接入？历史日志会保留。')) return;
  try { await api('/api/vehicle/disconnect', 'POST'); await load(); } catch (e) { message('setupMessage', e.message); } });
$('logout').addEventListener('click', async () => { try { await api('/api/logout', 'POST'); } finally { csrf = null; await load(); } });
load(); setInterval(() => { if (csrf) void load(); }, 30_000);
