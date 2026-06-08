/* =========================================================
 *  果趣订单 - 游戏主逻辑 (投放 + 自动合成 / 合成大西瓜式)
 *  玩法: 顶部瞄准投放水果, 落入木箱(物理), 两个相同水果相遇自动
 *        合成升级; 合成出订单目标水果即收集, 集满即通关; 溢出则失败。
 * ========================================================= */

(() => {
  'use strict';

  // ---------- 合成链 (从小到大, index 即等级 tier) ----------
  const TIERS = [
    { key: 'blueberry',   r: 19, color: '#4a64d8', name: '蓝莓' },
    { key: 'grape',       r: 23, color: '#9b54c8', name: '葡萄' },
    { key: 'strawberry',  r: 28, color: '#ff4d5e', name: '草莓' },
    { key: 'lemon',       r: 34, color: '#ffd23f', name: '柠檬' },
    { key: 'orange',      r: 41, color: '#ff8a2b', name: '橙子' },
    { key: 'peach',       r: 49, color: '#ff9e7a', name: '桃子' },
    { key: 'apple',       r: 58, color: '#e8413a', name: '苹果' },
    { key: 'watermelon',  r: 69, color: '#3fae5a', name: '西瓜' },
  ];
  const TOP = TIERS.length - 1;
  const DROP_TIERS = [0, 0, 1, 1, 2]; // 投放池 (偏向小果)

  // ---------- 图片预加载 ----------
  const IMG = {};
  function loadImages() {
    const add = (key, src) => { const im = new Image(); im.src = src; IMG[key] = im; };
    TIERS.forEach(f => add(f.key, `assets/fruits/${f.key}.png`));
    ['rainbow', 'bomb', 'slice', 'rainbow_blast', 'bomb_blast', 'slice_blast']
      .forEach(k => add(k, `assets/special/${k}.png`));
    add('crate', 'assets/scene/crate.png');
    add('stand', 'assets/scene/stand.png');
    add('hecheng', 'assets/scene/hecheng.png');
    add('swirl', 'assets/scene/swirl.png');
  }
  function fruitIcon(tier, cls = 'fruit-ico') {
    return `<img class="${cls}" src="assets/fruits/${TIERS[tier].key}.png" alt="">`;
  }

  // ---------- 关卡配置 ----------
  function makeLevel(n) {
    // 目标更高(需要合成更多次), 随关卡继续升高直到西瓜
    const targetTier = Math.min(5 + Math.floor((n - 1) / 2), TOP); // L1=桃子(5), L3=苹果, L5=西瓜
    const need = 3 + Math.floor((n - 1) / 3);                       // 需求数量随关卡增加
    const reward = 400 + n * 50;
    return { n, targetTier, need, reward, comboGoal: 6 };
  }

  // ---------- 全局状态 ----------
  const state = { coins: 2450, lives: 5, gems: 120, level: 1, maxLevel: 1 };

  // ---------- DOM ----------
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const canvas = $('#game-canvas');
  const ctx = canvas.getContext('2d');
  const screens = {
    menu: $('#screen-menu'), map: $('#screen-map'), help: $('#screen-help'),
    win: $('#screen-win'), lose: $('#screen-lose'),
  };
  const hud = $('#hud');

  // ---------- 画布尺寸 ----------
  let W = 0, H = 0, DPR = 1;
  function resize() {
    const rect = $('#app').getBoundingClientRect();
    W = rect.width; H = rect.height;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * DPR; canvas.height = H * DPR;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (game) game.layout();
  }
  window.addEventListener('resize', resize);

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------- 游戏实例 ----------
  let game = null;

  class Game {
    constructor() {
      this.world = null; this.box = null; this.cfg = null;
      this.running = false; this.ended = false;
      this.progress = 0; this.score = 0;
      this.combo = 0; this.comboTimer = 0; this.bestCombo = 0; this.comboCur = 0;
      this.particles = []; this.blasts = [];
      this.tools = { shuffle: 2, hammer: 2, magnet: 1, rainbow: 1 };
      this.activeTool = null;
      this.cur = 0; this.nxt = 0; this.curSpecial = null;
      this.aimX = 0; this.dropCD = 0; this.overflowT = 0;
      this.lastT = 0; this._raf = null;
      this.layout();
    }

    layout() {
      // 宽而浅的果箱 (贴合木箱图比例, 避免拉伸)
      const pad = W * 0.04;
      const w = W - pad * 2;
      const h = w * 0.95;
      let top = H * 0.30;
      const maxBottom = H - H * 0.155;
      if (top + h > maxBottom) top = maxBottom - h;
      this.box = { x: pad, y: top, w, h };
      if (this.world) this.world.setBounds(this.box);
      this.aimX = this.box.x + this.box.w / 2;
    }

    start(level) {
      this.cfg = makeLevel(level);
      this.world = new World(this.box);
      this.world.gravity = 2600;
      this.progress = 0; this.score = 0;
      this.combo = 0; this.bestCombo = 0; this.comboTimer = 0; this.comboCur = 0;
      this.ended = false; this.running = true;
      this.particles = []; this.blasts = [];
      this.tools = { shuffle: 2, hammer: 2, magnet: 1, rainbow: 1 };
      this.activeTool = null; this.curSpecial = null;
      this.overflowT = 0; this.dropCD = 0;
      this.aimX = this.box.x + this.box.w / 2;
      this.mergeEnabled = false; this.settleT = 0; this._reSolvedOnce = false; // 开局先沉降, 期间不合成
      // 投放池: 0 .. (目标-2) 的多种小果, 均匀随机
      this.dropPool = [];
      for (let t = 0; t <= Math.min(this.cfg.targetTier - 2, 3); t++) this.dropPool.push(t);
      if (this.dropPool.length < 2) this.dropPool = [0, 1, 2];
      this.cur = this.randDrop(); this.nxt = this.randDrop();
      this.prefill();
      this.syncHud(); this.syncNext();
      this.lastT = performance.now();
      if (!this._raf) this.loop();
    }

    // 开局预填充: 随机多种水果自然堆叠成一堆 (沉降后再消同种冲突, 保证不连锁)
    prefill() {
      const b = this.box;
      // 4 种小果(目标以下), 用四色网格铺满: (col+2row)%4 保证 8 邻域不同种 -> 稳定不连锁
      const small = [];
      for (let t = 0; t <= Math.min(this.cfg.targetTier - 1, 4); t++) small.push(t);
      while (small.length < 4) small.push(small.length % 2);
      const four = small.slice(0, 4);
      this.smalls = four.slice();
      this.palette = four.slice();
      const ur = 25;            // 预填充统一半径 -> 紧密铺排不滚动, 四色稳定
      const cols = Math.max(5, Math.floor(b.w / (ur * 2)));
      const cw = b.w / cols;
      const sy = ur * 1.96;
      const fillH = b.h * 0.66;
      const rows = Math.max(3, Math.floor(fillH / sy));
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const t = four[(col + 2 * row) % 4];
          const x = b.x + cw * (col + 0.5) + (Math.random() - 0.5) * cw * 0.12;
          const y = b.y + b.h - ur - row * sy - 2;
          const body = new Body(clamp(x, b.x + ur, b.x + b.w - ur), y, ur, t);
          body.scale = 1; body.fresh = 0;
          this.world.add(body);
        }
      }
    }

    // 沉降完成后, 把相互接触的同种水果改色, 确保开局没有可立即合成的同种对
    resolveConflicts() {
      const list = () => this.world.bodies.filter(o => !o.special && o.type < this.cfg.targetTier);
      const pal = this.palette || [0, 1, 2, 3];
      for (let iter = 0; iter < 400; iter++) {
        let changed = false;
        const arr = list();
        for (const a of arr) {
          const used = new Set();
          let conflict = false;
          for (const c of arr) {
            if (c === a) continue;
            const dx = c.x - a.x, dy = c.y - a.y, rr = a.r + c.r + 8;
            if (dx * dx + dy * dy <= rr * rr) { used.add(c.type); if (c.type === a.type) conflict = true; }
          }
          if (conflict) {
            const free = pal.filter(t => !used.has(t));
            const freeSmall = free.filter(t => t !== this.cfg.targetTier);
            const pool = freeSmall.length ? freeSmall : (free.length ? free : this.smalls);
            const nt = pool[Math.floor(Math.random() * pool.length)];
            a.type = nt; a.r = TIERS[nt].r; changed = true;
          }
        }
        if (!changed) break;
      }
    }

    randDrop() {
      // 均匀随机于投放池(开局根据目标等级确定的多种小果)
      const pool = this.dropPool && this.dropPool.length ? this.dropPool : [0, 1, 2];
      return pool[Math.floor(Math.random() * pool.length)];
    }

    // ---------- 主循环 ----------
    loop() {
      this._raf = requestAnimationFrame(() => this.loop());
      const now = performance.now();
      let dt = (now - this.lastT) / 1000; this.lastT = now;
      if (dt > 0.05) dt = 0.05;

      if (this.running && !this.ended) {
        if (this.dropCD > 0) this.dropCD -= dt;
        if (this.comboTimer > 0) { this.comboTimer -= dt; if (this.comboTimer <= 0) { this.combo = 0; this.comboCur = 0; this.syncCombo(); } }
        this.world.step(dt);
        if (this.mergeEnabled) {
          this.mergeStep();
        } else {
          this.settleT += dt;
          if (this.settleT >= 0.6 && !this._reSolvedOnce) { this.resolveConflicts(); this._reSolvedOnce = true; }
          if (this.settleT >= 1.4) { this.resolveConflicts(); this.mergeEnabled = true; }
        }
        this.updateParticles(dt);
        this.updateBlasts(dt);
        this.checkOverflow(dt);
      }
      this.render();
    }

    // ---------- 投放 ----------
    drop() {
      if (this.dropCD > 0 || this.ended || !this.running || !this.mergeEnabled) return;
      const special = this.curSpecial;
      const t = this.cur;
      const r = special ? TIERS[2].r : TIERS[t].r;
      const x = clamp(this.aimX, this.box.x + r, this.box.x + this.box.w - r);
      const b = new Body(x, this.box.y - r - 2, r, t);
      b.scale = 1; b.vy = 80; b.fresh = 0.25;
      if (special) b.special = special;
      this.world.add(b);
      this.curSpecial = null;
      this.cur = this.nxt; this.nxt = this.randDrop();
      this.dropCD = 0.36;
      this.syncNext();
    }

    // ---------- 合成 ----------
    mergeStep() {
      for (let iter = 0; iter < 10; iter++) {
        const pair = this.findMergePair();
        if (!pair) break;
        this.merge(pair[0], pair[1]);
      }
      this.world.clearRemoved();
    }

    findMergePair() {
      const arr = this.world.bodies;
      for (let i = 0; i < arr.length; i++) {
        const a = arr[i];
        if (a.removed) continue;
        for (let j = i + 1; j < arr.length; j++) {
          const c = arr[j];
          if (c.removed) continue;
          const rainbow = a.special === 'rainbow' || c.special === 'rainbow';
          if (!rainbow && a.type !== c.type) continue;
          if (!rainbow && a.type >= this.cfg.targetTier) continue; // 已是目标级不再合
          const dx = c.x - a.x, dy = c.y - a.y;
          const rr = (a.r + c.r) + 7; // 相接(含少量间隙)即视为可合成
          if (dx * dx + dy * dy <= rr * rr) return [a, c];
        }
      }
      return null;
    }

    merge(a, c) {
      // 彩虹果: 取另一个的等级
      let baseTier;
      if (a.special === 'rainbow' && c.special === 'rainbow') baseTier = Math.min(a.type, c.type);
      else if (a.special === 'rainbow') baseTier = c.type;
      else if (c.special === 'rainbow') baseTier = a.type;
      else baseTier = a.type;

      const mx = (a.x + c.x) / 2, my = (a.y + c.y) / 2;
      this.world.remove(a); this.world.remove(c);

      const nt = Math.min(baseTier + 1, this.cfg.targetTier);

      // 连击
      this.combo++; this.comboTimer = 2.2;
      this.bestCombo = Math.max(this.bestCombo, this.combo);
      this.comboCur++;
      if (this.comboCur >= this.cfg.comboGoal) {
        this.comboCur = 0;
        this.score += 300;
        this.floatText('连击奖励 +300', mx, my - 30);
        this.tools.rainbow++; // 奖励一颗彩虹果
        this.updateToolBadges();
      }
      const mult = 1 + (this.combo - 1) * 0.2;
      const gain = Math.round((baseTier + 1) * 30 * mult);
      this.score += gain;

      this.spawnParticles({ x: mx, y: my, type: nt });
      this.spawnFx('burst', mx, my, { size: TIERS[nt].r * 4, life: 0.45, s0: 0.4, s1: 1.5 });
      this.spawnFx('hecheng', mx, my - 6, { size: 120, life: 0.7, s0: 0.4, s1: 1.05, rise: 26 });
      if (this.combo >= 2) this.showCombo(this.combo);

      if (nt >= this.cfg.targetTier) {
        // 合成出目标水果 -> 收集
        this.progress = Math.min(this.cfg.need, this.progress + 1);
        this.spawnFx('burst', mx, my, { size: 150, life: 0.6, s0: 0.5, s1: 1.8 });
        this.floatText('订单 +1', mx, my - 26);
        this.syncHud();
        if (this.progress >= this.cfg.need) { this.win(); return; }
      } else {
        const nb = new Body(mx, my, TIERS[nt].r, nt);
        nb.scale = 0.4; nb.vy = -60; nb.fresh = 0.2;
        this.world.add(nb);
      }
      this.syncCombo();
    }

    // ---------- 溢出检测 ----------
    checkOverflow(dt) {
      const line = this.box.y + this.box.h * 0.08;
      let over = false;
      for (const o of this.world.bodies) {
        if (o.fresh > 0) continue;
        if (o.y - o.r < line && Math.abs(o.vy) < 55) { over = true; break; }
      }
      // 更新 fresh 计时
      for (const o of this.world.bodies) if (o.fresh > 0) o.fresh -= dt;

      const warn = $('#overflow-warn');
      if (over) {
        this.overflowT += dt;
        warn.classList.add('danger');
        if (this.overflowT >= 1.8) this.fail();
      } else {
        this.overflowT = Math.max(0, this.overflowT - dt * 2);
        if (this.overflowT <= 0.01) warn.classList.remove('danger');
      }
    }

    // ---------- 道具 ----------
    useTool(tool) {
      if (this.ended || !this.running) return;
      if (this.tools[tool] <= 0) { this.floatTextCenter('道具不足'); return; }
      if (tool === 'shuffle') {
        this.tools.shuffle--;
        for (const o of this.world.bodies) {
          o.x = this.box.x + o.r + Math.random() * (this.box.w - o.r * 2);
          o.y = this.box.y + o.r + Math.random() * (this.box.h * 0.6);
          o.vx = (Math.random() - 0.5) * 200; o.vy = 0; o.fresh = 0.2;
        }
        this.floatTextCenter('🔀 已洗牌');
      } else if (tool === 'hammer') {
        this.activeTool = this.activeTool === 'hammer' ? null : 'hammer';
        $('#tool-hint').classList.toggle('hidden', this.activeTool !== 'hammer');
      } else if (tool === 'magnet') {
        this.tools.magnet--;
        // 找数量最多的等级, 把它们吸到质心触发合成
        const groups = {};
        for (const o of this.world.bodies) { if (o.special) continue; (groups[o.type] = groups[o.type] || []).push(o); }
        let best = null, bn = 0;
        for (const k in groups) if (groups[k].length > bn) { bn = groups[k].length; best = groups[k]; }
        if (best && best.length >= 2) {
          let cx = 0, cy = 0; best.forEach(o => { cx += o.x; cy += o.y; }); cx /= best.length; cy /= best.length;
          best.forEach(o => { o.vx = (cx - o.x) * 6; o.vy = (cy - o.y) * 6; o.fresh = 0; });
          this.floatTextCenter('🧲 吸引同类');
        } else { this.tools.magnet++; this.floatTextCenter('没有可吸引的同类'); }
      } else if (tool === 'rainbow') {
        this.tools.rainbow--;
        this.curSpecial = 'rainbow';
        this.floatTextCenter('🌈 下一投为彩虹果');
      }
      this.activeTool = (tool === 'hammer') ? this.activeTool : null;
      this.updateToolBadges();
    }

    hammerHit(b) {
      if (!b) return;
      this.tools.hammer--;
      this.spawnParticles(b, 12, '#fff');
      this.world.remove(b); this.world.clearRemoved();
      this.score += 20;
      this.floatText('🔨', b.x, b.y);
      this.activeTool = null;
      $('#tool-hint').classList.add('hidden');
      this.updateToolBadges();
    }

    updateToolBadges() {
      $$('.tool-btn').forEach(btn => {
        const t = btn.dataset.tool;
        const badge = btn.querySelector('.tool-badge');
        if (badge) badge.textContent = this.tools[t];
        btn.classList.toggle('depleted', this.tools[t] <= 0);
        btn.classList.toggle('active', this.activeTool === t);
      });
    }

    // ---------- 输入 ----------
    pointerDown(x, y) {
      if (!this.running || this.ended) return;
      if (this.activeTool === 'hammer') {
        const b = this.world.pick(x, y);
        if (b) this.hammerHit(b);
        return;
      }
      this.aiming = true;
      this.aimX = x;
    }
    pointerMove(x, y) { if (this.aiming) this.aimX = x; }
    pointerUp() {
      if (this.aiming) { this.aiming = false; this.drop(); }
    }

    // ---------- 粒子 / 文字 / 爆炸 ----------
    spawnParticles(o, n = 9, color) {
      const c = color || (TIERS[o.type] && TIERS[o.type].color) || '#fff';
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, sp = 80 + Math.random() * 220;
        this.particles.push({ x: o.x, y: o.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60, life: 0.5 + Math.random() * 0.4, t: 0, r: 3 + Math.random() * 4, color: c });
      }
    }
    updateParticles(dt) { for (const p of this.particles) { p.t += dt; p.vy += 1200 * dt; p.x += p.vx * dt; p.y += p.vy * dt; } this.particles = this.particles.filter(p => p.t < p.life); }
    // 通用精灵特效: imgKey 指向 IMG, 从 s0 缩放到 s1 并淡出, 可上浮 rise 像素
    spawnFx(imgKey, x, y, o = {}) {
      this.blasts.push({ imgKey, x, y, t: 0, life: o.life || 0.5, size: o.size || 90, s0: o.s0 ?? 0.5, s1: o.s1 ?? 1.6, rise: o.rise || 0 });
    }
    updateBlasts(dt) { for (const b of this.blasts) b.t += dt; this.blasts = this.blasts.filter(b => b.t < b.life); }
    floatText(txt, x, y) {
      const el = document.createElement('div'); el.className = 'float-score'; el.textContent = txt;
      el.style.left = x + 'px'; el.style.top = y + 'px';
      $('#float-layer').appendChild(el); setTimeout(() => el.remove(), 900);
    }
    floatTextCenter(txt) { this.floatText(txt, W / 2, H * 0.45); }
    showCombo(n) { const el = $('#combo-pop'); el.textContent = `合成连击 x${n}!`; el.classList.remove('show'); void el.offsetWidth; el.classList.add('show'); }

    // ---------- 渲染 ----------
    render() {
      ctx.clearRect(0, 0, W, H);
      this.drawBox();
      this.drawDangerLine();
      // 水果裁剪在箱体内 (上方留空让落下的水果可见, 下方不溢出前壁)
      const b = this.box;
      ctx.save();
      ctx.beginPath();
      ctx.rect(b.x - 4, b.y - 100, b.w + 8, b.h + 100);
      ctx.clip();
      const bodies = this.world ? this.world.bodies : [];
      for (const o of bodies) this.drawFruitShadow(o);
      for (const o of bodies) this.drawFruit(o);
      ctx.restore();
      this.drawBlasts();
      this.drawParticles();
      if (this.running && !this.ended) this.drawAimer();
    }

    // 背景装饰 (果摊) — 画在画布上, 位于 HUD 之下
    drawScenery() {
      const stand = IMG['stand'];
      if (stand && stand.complete && stand.naturalWidth) {
        const w = W * 0.42, s = w / stand.naturalWidth;
        ctx.save(); ctx.globalAlpha = 0.96;
        ctx.drawImage(stand, W - w + 10, this.box.y - stand.naturalHeight * s * 0.62, w, stand.naturalHeight * s);
        ctx.restore();
      }
    }

    drawBox() {
      const b = this.box, crate = IMG['crate'];
      ctx.save();
      // 深色内壁 (回退; 大部分被木箱图盖住)
      const grad = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
      grad.addColorStop(0, '#6b4a30'); grad.addColorStop(1, '#523823');
      ctx.fillStyle = grad;
      roundRect(ctx, b.x + b.w * 0.04, b.y + b.h * 0.06, b.w * 0.92, b.h * 0.9, 14); ctx.fill();
      if (crate && crate.complete && crate.naturalWidth) {
        // 开口木箱: 内部开口对齐玩法区
        const wx = b.w * 0.10, wt = b.h * 0.10, wb = b.h * 0.12;
        ctx.drawImage(crate, b.x - wx, b.y - wt, b.w + wx * 2, b.h + wt + wb);
      }
      ctx.restore();
    }

    drawDangerLine() {
      const b = this.box, y = b.y + b.h * 0.1;
      ctx.save();
      ctx.strokeStyle = 'rgba(230,40,40,0.85)';
      ctx.lineWidth = 3; ctx.setLineDash([10, 7]);
      ctx.beginPath(); ctx.moveTo(b.x + 8, y); ctx.lineTo(b.x + b.w - 8, y); ctx.stroke();
      ctx.restore();
    }

    drawFruitShadow(o) {
      const r = o.r * o.scale;
      ctx.save(); ctx.globalAlpha = 0.16; ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.ellipse(o.x + 3, o.y + r * 0.55, r * 0.85, r * 0.4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    drawFruit(o) {
      const r = o.r * o.scale;
      const img = o.special ? IMG[o.special] : IMG[TIERS[o.type].key];
      ctx.save(); ctx.translate(o.x, o.y);
      if (o.special === 'rainbow') { ctx.shadowColor = 'rgba(255,255,255,0.9)'; ctx.shadowBlur = 14; }
      if (img && img.complete && img.naturalWidth) {
        const d = r * 2 * 1.12, iw = img.naturalWidth, ih = img.naturalHeight, s = d / Math.max(iw, ih);
        ctx.drawImage(img, -iw * s / 2, -ih * s / 2, iw * s, ih * s);
      } else {
        ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
        const c = TIERS[o.type] ? TIERS[o.type].color : '#fff';
        const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.2, 0, 0, r);
        g.addColorStop(0, lighten(c, 0.35)); g.addColorStop(1, c);
        ctx.fillStyle = g; ctx.fill();
      }
      ctx.restore();
    }

    drawAimer() {
      const t = this.cur, special = this.curSpecial;
      const r = special ? TIERS[2].r : TIERS[t].r;
      const x = clamp(this.aimX, this.box.x + r, this.box.x + this.box.w - r);
      const topY = this.box.y - r - 2;
      // 虚线投放轨迹
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 3; ctx.setLineDash([4, 10]); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x, topY + r); ctx.lineTo(x, this.box.y + this.box.h - 10); ctx.stroke();
      ctx.restore();
      // 待投放水果
      const img = special ? IMG['rainbow'] : IMG[TIERS[t].key];
      if (img && img.complete && img.naturalWidth) {
        const d = r * 2 * 1.12, iw = img.naturalWidth, ih = img.naturalHeight, s = d / Math.max(iw, ih);
        ctx.save();
        if (special) { ctx.shadowColor = 'rgba(255,255,255,0.9)'; ctx.shadowBlur = 16; }
        ctx.globalAlpha = this.dropCD > 0 ? 0.4 : 1;
        ctx.drawImage(img, x - iw * s / 2, topY - ih * s / 2, iw * s, ih * s);
        ctx.restore();
      }
    }

    drawBlasts() {
      for (const b of this.blasts) {
        const img = IMG[b.imgKey]; if (!img || !img.complete || !img.naturalWidth) continue;
        const p = b.t / b.life;
        const scale = b.s0 + (b.s1 - b.s0) * p;
        const size = b.size * scale;
        const alpha = p < 0.2 ? p / 0.2 : 1 - (p - 0.2) / 0.8; // 快入慢出
        ctx.save(); ctx.globalAlpha = Math.max(0, alpha);
        const iw = img.naturalWidth, ih = img.naturalHeight, s = size / Math.max(iw, ih);
        ctx.drawImage(img, b.x - iw * s / 2, b.y - b.rise * p - ih * s / 2, iw * s, ih * s); ctx.restore();
      }
    }
    drawParticles() {
      for (const p of this.particles) {
        ctx.save(); ctx.globalAlpha = Math.max(0, 1 - p.t / p.life); ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      }
    }

    // ---------- HUD ----------
    syncHud() {
      const tgt = this.cfg.targetTier;
      $('#hud-level').textContent = this.cfg.n;
      $('#hud-lives').textContent = state.lives;
      $('#hud-coins').textContent = state.coins.toLocaleString();
      $('#order-emoji').src = `assets/fruits/${TIERS[tgt].key}.png`;
      $('#order-name').textContent = TIERS[tgt].name;
      $('#order-need').textContent = Math.max(0, this.cfg.need - this.progress);
      $('#order-reward').textContent = this.cfg.reward;
      this.syncCombo();
      this.updateToolBadges();
    }
    syncNext() {
      const el = $('#next-fruit');
      if (el) el.src = this.nxt != null ? `assets/fruits/${TIERS[this.nxt].key}.png` : '';
    }
    syncCombo() {
      const f = $('#combo-fill'); if (f) f.style.width = (this.comboCur / this.cfg.comboGoal * 100) + '%';
      const c = $('#combo-cur'); if (c) c.textContent = this.comboCur;
      const g = $('#combo-goal'); if (g) g.textContent = this.cfg.comboGoal;
    }

    // ---------- 结算 ----------
    win() {
      if (this.ended) return;
      this.ended = true; this.running = false;
      state.coins += this.cfg.reward;
      state.maxLevel = Math.max(state.maxLevel, this.cfg.n + 1);
      const stars = this.calcStars();
      $('#win-emoji').innerHTML = fruitIcon(this.cfg.targetTier);
      $('#win-need').textContent = this.cfg.need;
      $('#win-score').textContent = this.score;
      $('#win-combo').textContent = this.bestCombo;
      $('#win-coin').textContent = this.cfg.reward;
      $$('#win-stars span').forEach((s, i) => s.style.opacity = i < stars ? '1' : '0.25');
      setTimeout(() => showScreen('win'), 500);
    }
    calcStars() {
      // 越快(连击越高)星越多
      if (this.bestCombo >= 6) return 3;
      if (this.bestCombo >= 3) return 2;
      return 1;
    }
    fail() {
      if (this.ended) return;
      this.ended = true; this.running = false;
      $('#overflow-warn').classList.add('hidden');
      $('#lose-emoji').innerHTML = fruitIcon(this.cfg.targetTier);
      $('#lose-have').textContent = this.progress;
      $('#lose-need').textContent = this.cfg.need;
      $('#lose-left').textContent = Math.max(0, this.cfg.need - this.progress);
      setTimeout(() => showScreen('lose'), 400);
    }
    revive() {
      if (state.gems < 5) { this.floatTextCenter('💎 不足'); return; }
      state.gems -= 5;
      // 清理顶部一批水果腾出空间
      const sorted = this.world.bodies.filter(o => o.fresh <= 0).sort((a, b) => a.y - b.y);
      sorted.slice(0, Math.ceil(sorted.length * 0.35)).forEach(o => { this.spawnParticles(o); this.world.remove(o); });
      this.world.clearRemoved();
      this.overflowT = 0; this.ended = false; this.running = true;
      this.lastT = performance.now();
      hideAllScreens(); hud.classList.remove('hidden');
    }
  }

  // ---------- 工具函数 ----------
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function lighten(hex, amt) {
    const c = hex.replace('#', '');
    const num = parseInt(c.length === 3 ? c.split('').map(x => x + x).join('') : c, 16);
    let r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
    r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt;
    return `rgb(${r | 0},${g | 0},${b | 0})`;
  }

  // ---------- 屏幕管理 ----------
  function hideAllScreens() { Object.values(screens).forEach(s => s.classList.add('hidden')); }
  function showScreen(name) {
    hideAllScreens(); hud.classList.add('hidden');
    if (screens[name]) screens[name].classList.remove('hidden');
    if (name === 'menu') refreshMenu();
    if (name === 'map') refreshMap();
  }
  function showGame() { hideAllScreens(); hud.classList.remove('hidden'); }

  function refreshMenu() {
    // 主菜单订单面板严格按原型静态展示 (第12关·西瓜x3·600), 不动态覆盖
  }

  function refreshMap() {
    $$('.coins-val').forEach(e => e.textContent = state.coins.toLocaleString());
    $('#map-cur-level').textContent = state.level;
    const path = $('#map-path'); path.innerHTML = '';
    const startN = Math.max(1, state.level - 2);
    const nodes = [];
    for (let i = startN; i < startN + 6; i++) nodes.push(i);
    nodes.reverse();
    nodes.forEach((n) => {
      const node = document.createElement('div');
      const unlocked = n <= state.maxLevel, cur = n === state.level;
      node.className = 'map-node' + (cur ? ' cur' : '') + (unlocked ? '' : ' locked');
      node.style.marginLeft = ((Math.sin(n * 1.3) * 0.5 + 0.5) * 50) + '%';
      node.innerHTML = `<span class="node-num">${n}</span>`;
      if (unlocked) node.addEventListener('click', () => { state.level = n; $('#map-cur-level').textContent = n; });
      path.appendChild(node);
    });
  }

  function launchLevel(level) {
    if (state.lives <= 0) { alert('生命不足，请等待恢复或前往商店'); return; }
    state.lives--;
    showGame(); game.start(level);
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    $('#btn-start').addEventListener('click', () => launchLevel(state.level));
    $$('.nav-item, .mid-panel').forEach(it => it.addEventListener('click', () => {
      const nav = it.dataset.nav;
      if (nav === 'map') showScreen('map');
      else if (nav === 'daily') { state.coins += 200; refreshMenu(); alert('领取每日奖励 +200 🪙'); }
      else if (nav === 'checkin') alert('今日已签到 ✅');
      else if (nav === 'activity') alert('活动中心开发中 🎉');
      else if (nav === 'shop') alert('商店开发中 🛒');
      else if (nav === 'collect') alert('图鉴开发中 📖');
      else if (nav === 'task') alert('任务开发中 ✅');
      else if (nav === 'rank') alert('排行榜开发中 🏆');
    }));
    $('#btn-map-start').addEventListener('click', () => launchLevel(state.level));
    $$('[data-back]').forEach(b => b.addEventListener('click', () => showScreen(b.dataset.back)));
    $$('[data-close]').forEach(b => b.addEventListener('click', () => screens.help.classList.add('hidden')));
    $$('.tool-btn').forEach(btn => btn.addEventListener('click', () => game.useTool(btn.dataset.tool)));

    $$('#screen-win [data-act]').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.act;
      if (a === 'next') { state.level = game.cfg.n + 1; launchLevel(state.level); }
      else if (a === 'replay') launchLevel(game.cfg.n);
      else showScreen('map');
    }));
    $('#btn-revive').addEventListener('click', () => game.revive());
    $$('#screen-lose [data-act]').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.act;
      if (a === 'replay') launchLevel(game.cfg.n);
      else { if (state.coins >= 300) state.coins -= 300; showScreen('map'); }
    }));

    const getPos = (e) => {
      const rect = canvas.getBoundingClientRect();
      const p = e.touches ? e.touches[0] : e;
      return { x: p.clientX - rect.left, y: p.clientY - rect.top };
    };
    const inGame = () => !hud.classList.contains('hidden');
    canvas.addEventListener('mousedown', (e) => { if (inGame()) { const p = getPos(e); game.pointerDown(p.x, p.y); } });
    window.addEventListener('mousemove', (e) => { if (game.aiming) { const p = getPos(e); game.pointerMove(p.x, p.y); } });
    window.addEventListener('mouseup', () => game.pointerUp());
    canvas.addEventListener('touchstart', (e) => { if (inGame()) { e.preventDefault(); const p = getPos(e); game.pointerDown(p.x, p.y); } }, { passive: false });
    canvas.addEventListener('touchmove', (e) => { if (game.aiming) { e.preventDefault(); const p = getPos(e); game.pointerMove(p.x, p.y); } }, { passive: false });
    window.addEventListener('touchend', () => game.pointerUp());
  }

  // ---------- 初始化 ----------
  window.addEventListener('load', () => {
    loadImages();
    resize();
    game = new Game();
    window.__game = game;
    bindEvents();
    showScreen('menu');
  });

})();
