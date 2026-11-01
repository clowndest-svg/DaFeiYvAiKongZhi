// QQ 语音会话（不是实时通话，是可打断的异步会话）。
//
// 这里只管状态与裁决，不碰网络也不碰进程：所有 IO 由 onebot 注入，
// 因此 12 组竞态交叉可以用假时钟穷举，而不靠真发消息碰运气。
//
// 两条不可让步的边界：
// 1) 作废发生在消息入站时，不是 flush 时；
// 2) markCommitting 之后到真正调用发送之间不许再有 await —— 否则校验形同虚设。

export const CALL_DEFAULTS = {
  maxBufferAgeMs: 5000,
  idleHangMs: 120000,
  maxSessionMs: 8 * 60000,
  sessionVoiceMax: 12,
  dailyVoiceMax: 40,
  minSendGapMs: 8000,
  ackAfterMs: 5000,
  spokenMaxChars: 60,
  spokenMinChars: 4,
};

export const ACK_TEXT = '收到你的语音啦，等我一下。';

export class VoiceCall {
  constructor({
    now = () => Date.now(),
    setTimeout: setTimeoutFn = globalThis.setTimeout,
    clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
    config = () => CALL_DEFAULTS,
    sendAck = async () => {},
    onEvent = () => {},
  } = {}) {
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.config = config;
    this.sendAck = sendAck;
    this.onEvent = onEvent;
    this.state = 'DISABLED';
    this.session = null;
    this.tickets = new Map();
    this.timers = new Set();
    this.lastSendAt = 0;
  }

  get active() {
    return this.state === 'ACTIVE';
  }

  cfg() {
    return { ...CALL_DEFAULTS, ...this.config() };
  }

  begin({ ownerId, accountGeneration, enabled }) {
    if (!enabled) return { ok: false, reason: '设置里没开语音对话模式' };
    if (!ownerId) return { ok: false, reason: '还没绑定主人 QQ' };
    if (this.active) return { ok: false, reason: '已经在语音会话里了' };
    const c = this.cfg();
    const at = this.now();
    this.session = {
      id: `S${at.toString(36)}`,
      ownerId: String(ownerId),
      accountGeneration,
      startedAt: at,
      lastInboundAt: at,
      turnGeneration: 0,
      voiceUsed: 0,
      voiceReserved: 0,
      turns: 0,
      ackSent: 0,
      state: 'ACTIVE',
    };
    this.state = 'ACTIVE';
    this.armWatchdog();
    this.onEvent('call_begin', { sessionId: this.session.id });
    return { ok: true, session: this.snapshot() };
  }

  end(reason) {
    if (!this.session) {
      this.state = 'DISABLED';
      return { ok: false, reason: '当前没有语音会话' };
    }
    const id = this.session.id;
    this.session.state = 'CLOSING';
    this.clearTimers();
    this.session = null;
    this.state = 'IDLE';
    this.onEvent('call_end', { sessionId: id, reason });
    return { ok: true, reason };
  }

  // 入站即作废：不新建 timer，只是抬高世代号，旧回合的异步结果自然过不了校验。
  noteInbound() {
    if (!this.active) return { cancelled: [] };
    const s = this.session;
    s.lastInboundAt = this.now();
    s.turnGeneration += 1;
    // 只抬高世代号，不在这里退额度：已经 markCommitting 的那条与真正写发送帧之间没有 await，
    // 要么确实发出去了，要么由调用方拿到 AbortError/失败后自己 settle('refunded')。
    return { cancelled: [], turnGeneration: s.turnGeneration };
  }

  openTurn({ accountGeneration, ownerId, batchFirstAt }) {
    if (!this.active) return null;
    const s = this.session;
    s.turnGeneration += 1;
    s.turns += 1;
    return Object.freeze({
      callSessionId: s.id,
      turnGeneration: s.turnGeneration,
      // generation 是给老的 assertCurrentWork 用的账号世代，两个计数器不许合并成一个数字。
      generation: accountGeneration,
      accountGeneration,
      ownerId: String(ownerId || ''),
      batchFirstAt: batchFirstAt || this.now(),
    });
  }

  // 账号世代与回合世代是两个独立计数器：重登录不能借旧会话继续发，旧会话也不能借新账号发。
  isCurrent(scope) {
    if (!scope || !scope.callSessionId) return true;
    if (!this.active) return false;
    const s = this.session;
    if (s.id !== scope.callSessionId) return false;
    if (s.turnGeneration !== scope.turnGeneration) return false;
    if (s.accountGeneration !== scope.accountGeneration) return false;
    if (s.ownerId !== scope.ownerId) return false;
    return true;
  }

  armAck(scope, text = ACK_TEXT) {
    if (!this.isCurrent(scope)) return null;
    const s = this.session;
    // 一个聚合批次最多确认一次；整场也有硬上限，不许变成"我在听"刷屏。
    if (s.ackTurn === scope.turnGeneration) return null;
    if (s.ackSent >= this.cfg().sessionVoiceMax) return null;
    const timer = this.setTimeoutFn(() => {
      this.timers.delete(timer);
      if (!this.isCurrent(scope)) return;
      if (s.committingTurn === scope.turnGeneration) return;
      s.ackTurn = scope.turnGeneration;
      s.ackSent += 1;
      this.onEvent('call_ack', { sessionId: s.id, turnGeneration: scope.turnGeneration });
      Promise.resolve()
        .then(() => this.sendAck(text, scope))
        .catch((error) => this.onEvent('call_ack_failed', { error: String(error && error.message) }));
    }, this.cfg().ackAfterMs);
    this.timers.add(timer);
    return timer;
  }

  // 唯一的发送裁决点：校验、扣额度、登记提交状态，全程同步，返回后调用方立刻发消息。
  markCommitting(scope, { dailyCount = 0 } = {}) {
    this.pruneTickets();
    if (!scope || !scope.callSessionId || !this.session) return { ok: false, reason: '不在语音会话里，不能按会话额度发' };
    if (!this.isCurrent(scope)) return { ok: false, reason: '回合已作废或会话已结束' };
    const s = this.session;
    const c = this.cfg();
    const at = this.now();
    if (at - this.lastSendAt < c.minSendGapMs) return { ok: false, reason: `两条语音之间至少隔 ${Math.round(c.minSendGapMs / 1000)} 秒` };
    if (s.voiceUsed + s.voiceReserved >= c.sessionVoiceMax) return { ok: false, reason: `这一场已经说了 ${s.voiceUsed} 条语音（上限 ${c.sessionVoiceMax}）` };
    if (dailyCount >= c.dailyVoiceMax) return { ok: false, reason: `今天的语音总量到线了（${dailyCount}/${c.dailyVoiceMax}）` };
    const ticketId = `${s.id}:${scope.turnGeneration}:${s.turns}`;
    const existed = this.tickets.get(ticketId);
    if (existed && existed.state !== 'RESERVED') return { ok: false, reason: '同一回合不重复提交' };
    s.voiceReserved += 1;
    s.committingTurn = scope.turnGeneration;
    this.tickets.set(ticketId, { state: 'COMMITTING', turnGeneration: scope.turnGeneration, at });
    return { ok: true, ticketId };
  }

  settle(ticketId, outcome) {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) return { ok: false, reason: '没有这张提交单' };
    // 一张提交单只结算一次：超时之后迟到的 ACK 不能再扣一遍额度。
    if (ticket.state !== 'COMMITTING') return { ok: false, reason: `这张单已经结算是 ${ticket.state}` };
    const s = this.session && this.session.id === String(ticketId).split(':')[0] ? this.session : null;
    // UNKNOWN 不返额度也不自动重发：发没发出去这件事我们已经不知道了。
    if (outcome === 'confirmed') {
      if (s) s.voiceReserved = Math.max(0, s.voiceReserved - 1);
      if (s) s.voiceUsed += 1;
      this.lastSendAt = this.now();
      if (s && s.committingTurn === ticket.turnGeneration) delete s.committingTurn;
      ticket.state = 'CONFIRMED';
    } else if (outcome === 'unknown') {
      if (s) s.voiceReserved = Math.max(0, s.voiceReserved - 1);
      if (s) s.voiceUsed += 1;
      this.lastSendAt = this.now();
      ticket.state = 'UNKNOWN';
    } else {
      if (s) s.voiceReserved = Math.max(0, s.voiceReserved - 1);
      if (s && s.committingTurn === ticket.turnGeneration) delete s.committingTurn;
      ticket.state = 'REFUNDED';
    }
    this.pruneTickets();
    return { ok: true, state: ticket.state };
  }

  pruneTickets() {
    // 已结算记录只承担近期幂等判据；淘汰后迟到回执仍会被拒绝，绝不再扣量。
    for (const [id, ticket] of this.tickets) {
      if (ticket.state === 'COMMITTING') continue;
      if (this.tickets.size <= 512 && this.now() - ticket.at < 86400000) continue;
      this.tickets.delete(id);
    }
  }

  // 只用一个看门狗定时器串起「空闲挂断」和「到点挂断」，会话结束即清除。
  armWatchdog() {
    if (!this.active) return;
    const c = this.cfg();
    const timer = this.setTimeoutFn(() => {
      this.timers.delete(timer);
      if (!this.active) return;
      const s = this.session;
      const at = this.now();
      if (at - s.lastInboundAt >= c.idleHangMs) {
        this.end('timeout_idle');
        return;
      }
      if (at - s.startedAt >= c.maxSessionMs) {
        this.end('timeout_session');
        return;
      }
      this.armWatchdog();
    }, Math.min(c.idleHangMs, c.maxSessionMs) / 4);
    this.timers.add(timer);
  }

  clearTimers() {
    for (const timer of this.timers) this.clearTimeoutFn(timer);
    this.timers.clear();
  }

  snapshot() {
    const s = this.session;
    const c = this.cfg();
    if (!s) {
      return { state: this.state, active: false, caps: { sessionVoiceMax: c.sessionVoiceMax, dailyVoiceMax: c.dailyVoiceMax, minSendGapMs: c.minSendGapMs, ackAfterMs: c.ackAfterMs } };
    }
    return {
      state: this.state,
      active: true,
      sessionId: s.id,
      startedAt: s.startedAt,
      minutesIn: Math.round((this.now() - s.startedAt) / 1000 / 60),
      turnGeneration: s.turnGeneration,
      voiceUsed: s.voiceUsed,
      voiceReserved: s.voiceReserved,
      ackSent: s.ackSent,
      caps: { sessionVoiceMax: c.sessionVoiceMax, dailyVoiceMax: c.dailyVoiceMax, minSendGapMs: c.minSendGapMs, ackAfterMs: c.ackAfterMs },
    };
  }
}
