/* =========================================================
 *  果趣订单 - 游戏主逻辑
 *  玩法: 木箱中堆满水果(物理), 拖动同类水果凑齐3个以上消除,
 *        在限时内完成订单(消除指定数量的目标水果)即通关。
 * ========================================================= */

(() => {
  'use strict';

  // ---------- 水果定义 (美术资产, color 用于消除粒子特效) ----------
  const FRUITS = [
    { key: 'strawberry',  color: '#ff4d5e', name: '草莓' },
    { key: 'blueberry',   color: '#4a64d8', name: '蓝莓' },
    { key: 'lemon',       color: '#ffd23f', name: '柠檬' },
    { key: 'peach',       color: '#ff9e7a', name: '桃子' },
    { key: 'grape',       color: '#9b54c8', name: '葡萄' },
    { key: 'watermelon',  color: '#3fae5a', name: '西瓜' },
    { key: 'kiwi',        color: '#8bc34a', name: '猕猴桃' },
    { key: 'orange',      color: '#ff8a2b', name: '橙子' },
    { key: 'pineapple',   color: '#f2c14e', name: '菠萝' },
    { key: 'apple',       color: '#e8413a', name: '苹果' },
    { key: 'pomegranate', color: '#e53b44', name: '石榴' },
    { key: 'coconut',     color: '#caa472', name: '椰子' },
  ];

  const SPECIAL = {
    rainbow: { key: 'rainbow', label: '彩虹果' },
    bomb:    { key: 'bomb',    label: '星星炸弹' },
    slice:   { key: 'slice',   label: '柠檬切片' },
  };

  // ---------- 图片预加载 ----------
  const IMG = {};
  function loadImages() {
    const add = (key, src) => { const im = new Image(); im.src = src; IMG[key] = im; };
    FRUITS.forEach(f => add(f.key, `assets/fruits/${f.key}.png`));
    ['rainbow', 'bomb', 'slice'].forEach(k => add(k, `assets/special/${k}.png`));
    ['rainbow_blast', 'bomb_blast', 'slice_blast'].forEach(k => add(k, `assets/special/${k}.png`));
    add('crate', 'assets/props/crate.png');
  }
  // 生成订单/结算里展示水果用的 <img> 标签
  function fruitIcon(type, cls = 'fruit-ico') {
    return `<img class="${cls}" src="assets/fruits/${FRUITS[type].key}.png" alt="">`;
  }

  // ---------- 关卡配置 ----------
  // typeCount: 本关使用的水果种类数; target: 订单目标水果索引; need: 需要消除数量
  function makeLevel(n) {
    const typeCount = Math.min(5 + Math.floor(n / 3), FRUITS.length);
    const target = (n * 3 + 5) % typeCount;          // 伪随机但稳定
    const need = 3 + Math.floor(n / 2) * 3;           // 3,3,6,6,9...
    const time = Math.max(45, 75 - n * 2);            // 时间随关卡缩短
    const reward = 400 + n * 50;
    return { n, typeCount, target, need, time, reward };
  }

  // ---------- 全局状态 ----------
  const state = {
    coins: 2450,
    lives: 5,
    gems: 120,
    level: 1,
    maxLevel: 1,
  };

  // ---------- DOM ----------
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const canvas = $('#game-canvas');
  const ctx = canvas.getContext('2d');

  const screens = {
    menu: $('#screen-menu'),
    map: $('#screen-map'),
    help: $('#screen-help'),
    win: $('#screen-win'),
    lose: $('#screen-lose'),
  };
  const hud = $('#hud');

  // ---------- 画布尺寸 ----------
  let W = 0, H = 0, DPR = 1;
  function resize() {
    const app = $('#app');
    const rect = app.getBoundingClientRect();
    W = rect.width;
    H = rect.height;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (game) game.layout();
  }
  window.addEventListener('resize', resize);

  // ---------- 游戏实例 ----------
  let game = null;

  class Game {
    constructor() {
      this.world = null;
      this.box = null;
      this.cfg = null;
      this.running = false;
      this.progress = 0;
      this.score = 0;
      this.combo = 0;
      this.comboTimer = 0;
      this.bestCombo = 0;
      this.timeLeft = 0;
      this.lastT = 0;
      this.drag = null;
      this.activeTool = null;
      this.tools = { shuffle: 3, hammer: 3, magnet: 1 };
      this.particles = [];
      this.blasts = [];
      this.ended = false;
      this.layout();
    }

    layout() {
      // 木箱区域: 屏幕中下部, 留出顶部 HUD 与底部道具栏空间
      const top = H * 0.30;
      const bottom = H * 0.84;
      const pad = W * 0.05;
      this.box = {
        x: pad,
        y: top,
        w: W - pad * 2,
        h: bottom - top,
      };
      if (this.world) this.world.setBounds(this.box);
      // 根据盒宽决定水果半径 (约 4.5 个一排)
      this.fruitR = Math.max(20, Math.min(34, this.box.w / 9));
    }

    start(level) {
      this.cfg = makeLevel(level);
      this.world = new World(this.box);
      this.progress = 0;
      this.score = 0;
      this.combo = 0;
      this.bestCombo = 0;
      this.comboTimer = 0;
      this.timeLeft = this.cfg.time;
      this.ended = false;
      this.running = true;
      this.particles = [];
      this.tools = { shuffle: 3, hammer: 3, magnet: 1 };
      this.activeTool = null;
      this.blasts = [];
      this.fillBox(true);
      this.syncHud();
      this.lastT = performance.now();
      if (!this._raf) this.loop();
    }

    // 用水果填满盒子
    fillBox(initial) {
      const r = this.fruitR;
      const cols = Math.floor(this.box.w / (r * 2));
      const rows = Math.floor(this.box.h / (r * 2));
      const cap = cols * rows;
      const wantMin = Math.floor(cap * 0.85);
      let count = this.world.count();
      const toAdd = Math.max(0, (initial ? cap : wantMin) - count);
      for (let i = 0; i < toAdd; i++) {
        this.spawnFruit();
      }
    }

    spawnFruit(forceType) {
      const r = this.fruitR;
      const b = this.box;
      const type = forceType !== undefined
        ? forceType
        : (Math.random() < 0.32 && this.cfg
            ? this.cfg.target
            : Math.floor(Math.random() * this.cfg.typeCount));
      const x = b.x + r + Math.random() * (b.w - r * 2);
      const y = b.y - r - Math.random() * r * 4; // 从顶部上方落下
      const body = new Body(x, y, r, type % this.cfg.typeCount);
      // 偶尔生成特殊水果
      const sp = Math.random();
      if (sp < 0.015) body.special = 'rainbow';
      else if (sp < 0.03) body.special = 'bomb';
      body.vy = 80;
      this.world.add(body);
      return body;
    }

    // ---------- 主循环 ----------
    loop() {
      this._raf = requestAnimationFrame(() => this.loop());
      const now = performance.now();
      let dt = (now - this.lastT) / 1000;
      this.lastT = now;
      if (dt > 0.05) dt = 0.05;

      if (this.running && !this.ended) {
        this.timeLeft -= dt;
        if (this.comboTimer > 0) {
          this.comboTimer -= dt;
          if (this.comboTimer <= 0) this.combo = 0;
        }
        this.world.step(dt);
        this.maintainFill();
        this.updateParticles(dt);
        this.updateBlasts(dt);
        if (this.timeLeft <= 0) {
          this.timeLeft = 0;
          this.fail();
        }
      }
      this.render();
      this.syncTimer();
    }

    maintainFill() {
      const r = this.fruitR;
      const cols = Math.floor(this.box.w / (r * 2));
      const rows = Math.floor(this.box.h / (r * 2));
      const wantMin = Math.floor(cols * rows * 0.8);
      if (this.world.count() < wantMin) {
        this.spawnFruit();
      }
    }

    // ---------- 消除逻辑 ----------
    tryClearFrom(body) {
      if (!body || body.removed) return;
      if (body.special === 'bomb') { this.detonate(body); return; }
      const comp = this.world.connectedSame(body);
      if (comp.length >= 3) {
        this.clearGroup(comp);
      }
    }

    clearGroup(comp) {
      let cleared = 0;
      let targetCleared = 0;
      let cx = 0, cy = 0;
      for (const o of comp) {
        if (o.removed) continue;
        cx += o.x; cy += o.y;
        if (o.special) this.spawnBlast(o.x, o.y, o.special);
        this.spawnParticles(o);
        if (o.type === this.cfg.target || o.special === 'rainbow') targetCleared++;
        this.world.remove(o);
        cleared++;
      }
      if (cleared === 0) return;
      cx /= cleared; cy /= cleared;

      // 连击
      this.combo++;
      this.comboTimer = 2.2;
      this.bestCombo = Math.max(this.bestCombo, this.combo);

      // 计分
      const base = cleared * 50;
      const gain = Math.round(base * (1 + (this.combo - 1) * 0.25));
      this.score += gain;
      this.floatText(`+${gain}`, cx, cy);
      if (this.combo >= 2) this.showCombo(this.combo);

      // 订单进度
      if (targetCleared > 0) {
        this.progress = Math.min(this.cfg.need, this.progress + targetCleared);
      }

      this.world.clearRemoved();
      this.syncHud();

      if (this.progress >= this.cfg.need) {
        this.win();
      }
    }

    detonate(bomb) {
      const radius = this.fruitR * 3.2;
      const hit = this.world.inRadius(bomb.x, bomb.y, radius);
      this.spawnBlast(bomb.x, bomb.y, 'bomb');
      this.spawnParticles(bomb, 18, '#ffd24a');
      let cleared = 0, targetCleared = 0;
      for (const o of hit) {
        this.spawnParticles(o);
        if (o.type === this.cfg.target) targetCleared++;
        this.world.remove(o);
        cleared++;
      }
      this.combo++;
      this.comboTimer = 2.2;
      this.score += cleared * 60;
      this.floatText(`💥 +${cleared * 60}`, bomb.x, bomb.y);
      if (targetCleared > 0)
        this.progress = Math.min(this.cfg.need, this.progress + targetCleared);
      this.world.clearRemoved();
      this.syncHud();
      if (this.progress >= this.cfg.need) this.win();
    }

    // ---------- 道具 ----------
    useTool(tool) {
      if (this.ended) return;
      if (this.tools[tool] <= 0) { this.floatTextCenter('道具不足'); return; }
      if (tool === 'shuffle') {
        this.tools.shuffle--;
        for (const o of this.world.bodies) {
          o.type = Math.floor(Math.random() * this.cfg.typeCount);
          o.vx = (Math.random() - 0.5) * 400;
          o.vy = -Math.random() * 300;
        }
        this.floatTextCenter('🔀 已洗牌');
        this.activeTool = null;
      } else if (tool === 'magnet') {
        this.tools.magnet--;
        // 吸取所有目标水果并消除
        const targets = this.world.bodies.filter(b => b.type === this.cfg.target);
        let n = 0;
        for (const o of targets) {
          this.spawnParticles(o);
          this.world.remove(o);
          n++;
        }
        if (n > 0) {
          this.progress = Math.min(this.cfg.need, this.progress + n);
          this.score += n * 50;
          this.floatTextCenter(`🧲 吸取 ${n} 个`);
        }
        this.world.clearRemoved();
        this.syncHud();
        this.activeTool = null;
        if (this.progress >= this.cfg.need) this.win();
      } else if (tool === 'hammer') {
        // 进入选择模式
        this.activeTool = this.activeTool === 'hammer' ? null : 'hammer';
        $('#tool-hint').classList.toggle('hidden', this.activeTool !== 'hammer');
      }
      this.updateToolBadges();
    }

    hammerHit(body) {
      if (!body) return;
      this.tools.hammer--;
      this.spawnParticles(body, 12, '#fff');
      if (body.type === this.cfg.target)
        this.progress = Math.min(this.cfg.need, this.progress + 1);
      this.world.remove(body);
      this.world.clearRemoved();
      this.score += 30;
      this.floatText('🔨', body.x, body.y);
      this.activeTool = null;
      $('#tool-hint').classList.add('hidden');
      this.updateToolBadges();
      this.syncHud();
      if (this.progress >= this.cfg.need) this.win();
    }

    updateToolBadges() {
      $$('.tool-btn').forEach(btn => {
        const t = btn.dataset.tool;
        const badge = btn.querySelector('.tool-badge');
        badge.textContent = this.tools[t];
        btn.classList.toggle('depleted', this.tools[t] <= 0);
        btn.classList.toggle('active', this.activeTool === t);
      });
    }

    // ---------- 拖拽输入 ----------
    pointerDown(x, y) {
      if (!this.running || this.ended) return;
      if (this.activeTool === 'hammer') {
        const b = this.world.pick(x, y);
        if (b) this.hammerHit(b);
        return;
      }
      const b = this.world.pick(x, y);
      if (!b) return;
      b.dragging = true;
      b.targetX = x;
      b.targetY = y;
      this.drag = b;
    }
    pointerMove(x, y) {
      if (this.drag) {
        this.drag.targetX = x;
        this.drag.targetY = y;
      }
    }
    pointerUp() {
      if (this.drag) {
        const b = this.drag;
        b.dragging = false;
        b.vx = b.vx * 0.3;
        b.vy = b.vy * 0.3;
        this.drag = null;
        // 释放后尝试消除其所在连通分量
        this.tryClearFrom(b);
      }
    }

    // ---------- 粒子 / 漂浮文字 ----------
    spawnParticles(o, n = 8, color) {
      const c = color || (FRUITS[o.type] && FRUITS[o.type].color) || '#fff';
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 80 + Math.random() * 220;
        this.particles.push({
          x: o.x, y: o.y,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60,
          life: 0.5 + Math.random() * 0.4, t: 0,
          r: 3 + Math.random() * 4, color: c,
        });
      }
    }
    spawnBlast(x, y, kind) {
      this.blasts.push({ x, y, kind, t: 0, life: 0.5 });
    }
    updateBlasts(dt) {
      for (const b of this.blasts) b.t += dt;
      this.blasts = this.blasts.filter(b => b.t < b.life);
    }
    drawBlasts() {
      for (const b of this.blasts) {
        const img = IMG[b.kind + '_blast'];
        if (!img || !img.complete || !img.naturalWidth) continue;
        const p = b.t / b.life;
        const scale = 0.5 + p * 1.4;
        const size = this.fruitR * 3.6 * scale;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - p);
        const iw = img.naturalWidth, ih = img.naturalHeight;
        const s = size / Math.max(iw, ih);
        ctx.drawImage(img, b.x - iw * s / 2, b.y - ih * s / 2, iw * s, ih * s);
        ctx.restore();
      }
    }
    updateParticles(dt) {
      for (const p of this.particles) {
        p.t += dt;
        p.vy += 1200 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      this.particles = this.particles.filter(p => p.t < p.life);
    }
    floatText(txt, x, y) {
      const layer = $('#float-layer');
      const el = document.createElement('div');
      el.className = 'float-score';
      el.textContent = txt;
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      layer.appendChild(el);
      setTimeout(() => el.remove(), 900);
    }
    floatTextCenter(txt) {
      this.floatText(txt, W / 2, H * 0.45);
    }
    showCombo(n) {
      const el = $('#combo-pop');
      el.textContent = `连击 x${n}!`;
      el.classList.remove('show');
      void el.offsetWidth;
      el.classList.add('show');
    }

    // ---------- 渲染 ----------
    render() {
      ctx.clearRect(0, 0, W, H);
      this.drawBox();
      // 阴影
      for (const o of this.world ? this.world.bodies : []) {
        this.drawFruitShadow(o);
      }
      for (const o of this.world ? this.world.bodies : []) {
        this.drawFruit(o);
      }
      this.drawBlasts();
      this.drawParticles();
      // 拖拽连线提示
      if (this.drag) this.drawDragHint(this.drag);
    }

    drawBox() {
      const b = this.box;
      const crate = IMG['crate'];
      ctx.save();
      // 内壁深色底 (让水果有容器感, 也作为图未加载时的回退)
      const r = 20;
      const grad = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
      grad.addColorStop(0, '#7a5436');
      grad.addColorStop(1, '#5e3f28');
      ctx.fillStyle = grad;
      roundRect(ctx, b.x, b.y, b.w, b.h, r);
      ctx.fill();
      if (crate && crate.complete && crate.naturalWidth) {
        // 木箱图: 适当放大覆盖, 让木壁在玩法区四周
        const pad = b.w * 0.10;
        ctx.drawImage(crate, b.x - pad, b.y - pad * 0.7,
          b.w + pad * 2, b.h + pad * 1.5);
      }
      ctx.restore();
    }

    drawFruitShadow(o) {
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(o.x + 3, o.y + o.r * 0.55, o.r * 0.85, o.r * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    drawFruit(o) {
      const r = o.r * o.scale;
      const color = FRUITS[o.type] ? FRUITS[o.type].color : '#fff';
      const img = o.special ? IMG[o.special] : IMG[FRUITS[o.type].key];
      ctx.save();
      ctx.translate(o.x, o.y);

      // 拖拽高亮
      if (o.dragging) {
        ctx.shadowColor = 'rgba(255,255,255,0.95)';
        ctx.shadowBlur = 20;
      }

      if (img && img.complete && img.naturalWidth) {
        // 保持比例缩放, 让水果直径约等于碰撞直径 (特殊果略大)
        const d = r * 2 * (o.special ? 1.18 : 1.12);
        const iw = img.naturalWidth, ih = img.naturalHeight;
        const s = d / Math.max(iw, ih);
        ctx.drawImage(img, -iw * s / 2, -ih * s / 2, iw * s, ih * s);
      } else {
        // 资源未加载时的彩色圆占位
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.2, 0, 0, r);
        g.addColorStop(0, lighten(color, 0.35));
        g.addColorStop(1, color);
        ctx.fillStyle = g;
        ctx.fill();
      }
      ctx.restore();
    }

    drawDragHint(o) {
      const comp = this.world.connectedSame(o);
      if (comp.length < 2) return;
      const ok = comp.length >= 3;
      ctx.save();
      ctx.strokeStyle = ok ? 'rgba(120,255,140,0.9)' : 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 4;
      for (const a of comp) {
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.r + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawParticles() {
      for (const p of this.particles) {
        const a = 1 - p.t / p.life;
        ctx.save();
        ctx.globalAlpha = Math.max(0, a);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    // ---------- HUD ----------
    syncHud() {
      $('#hud-level').textContent = this.cfg.n;
      $('#hud-score').textContent = this.score;
      $('#hud-lives').textContent = state.lives;
      $('#hud-coins').textContent = state.coins;
      $('#order-emoji').innerHTML = fruitIcon(this.cfg.target);
      $('#order-need').textContent = `${this.progress}/${this.cfg.need}`;
      $('#order-reward').textContent = this.cfg.reward;
      this.updateToolBadges();
    }
    syncTimer() {
      const t = Math.max(0, Math.ceil(this.timeLeft));
      const m = String(Math.floor(t / 60)).padStart(2, '0');
      const s = String(t % 60).padStart(2, '0');
      const el = $('#hud-timer');
      if (el) {
        el.textContent = `${m}:${s}`;
        el.classList.toggle('low', t <= 10);
      }
    }

    // ---------- 结算 ----------
    win() {
      if (this.ended) return;
      this.ended = true;
      this.running = false;
      state.coins += this.cfg.reward;
      state.maxLevel = Math.max(state.maxLevel, this.cfg.n + 1);
      const stars = this.calcStars();
      $('#win-emoji').innerHTML = fruitIcon(this.cfg.target);
      $('#win-need').textContent = this.cfg.need;
      $('#win-score').textContent = this.score;
      $('#win-combo').textContent = this.bestCombo;
      $('#win-coin').textContent = this.cfg.reward;
      $$('#win-stars span').forEach((s, i) => {
        s.style.opacity = i < stars ? '1' : '0.25';
      });
      setTimeout(() => showScreen('win'), 500);
    }
    calcStars() {
      const ratio = this.timeLeft / this.cfg.time;
      if (ratio > 0.45) return 3;
      if (ratio > 0.18) return 2;
      return 1;
    }
    fail() {
      if (this.ended) return;
      this.ended = true;
      this.running = false;
      $('#lose-emoji').innerHTML = fruitIcon(this.cfg.target);
      $('#lose-have').textContent = this.progress;
      $('#lose-need').textContent = this.cfg.need;
      $('#lose-left').textContent = Math.max(0, this.cfg.need - this.progress);
      setTimeout(() => showScreen('lose'), 400);
    }
    revive() {
      if (state.gems < 5) { this.floatTextCenter('💎 不足'); return; }
      state.gems -= 5;
      this.timeLeft += 5;
      this.ended = false;
      this.running = true;
      this.lastT = performance.now();
      hideAllScreens();
      hud.classList.remove('hidden');
    }
  }

  // ---------- 工具函数 ----------
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function lighten(hex, amt) {
    const c = hex.replace('#', '');
    const num = parseInt(c.length === 3 ? c.split('').map(x => x + x).join('') : c, 16);
    let r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
    r = Math.min(255, r + (255 - r) * amt);
    g = Math.min(255, g + (255 - g) * amt);
    b = Math.min(255, b + (255 - b) * amt);
    return `rgb(${r | 0},${g | 0},${b | 0})`;
  }

  // ---------- 屏幕管理 ----------
  function hideAllScreens() {
    Object.values(screens).forEach(s => s.classList.add('hidden'));
  }
  function showScreen(name) {
    hideAllScreens();
    hud.classList.add('hidden');
    if (screens[name]) screens[name].classList.remove('hidden');
    if (name === 'menu') refreshMenu();
    if (name === 'map') refreshMap();
  }
  function showGame() {
    hideAllScreens();
    hud.classList.remove('hidden');
  }

  function refreshMenu() {
    $$('.lives-val').forEach(e => e.textContent = state.lives);
    $$('.coins-val').forEach(e => e.textContent = state.coins);
    const cfg = makeLevel(state.level);
    $('.menu-level').textContent = state.level;
    $('#menu-order-emoji').innerHTML = fruitIcon(cfg.target);
    $('#menu-order-need').textContent = cfg.need;
    $('#menu-order-reward-val').textContent = cfg.reward;
  }

  function refreshMap() {
    $$('.coins-val').forEach(e => e.textContent = state.coins);
    $('#map-cur-level').textContent = state.level;
    const path = $('#map-path');
    path.innerHTML = '';
    // 生成关卡节点 (当前关附近)
    const startN = Math.max(1, state.level - 2);
    const nodes = [];
    for (let i = startN; i < startN + 6; i++) nodes.push(i);
    nodes.reverse(); // 上方是更高关卡
    nodes.forEach((n) => {
      const node = document.createElement('div');
      const unlocked = n <= state.maxLevel;
      const cur = n === state.level;
      node.className = 'map-node' + (cur ? ' cur' : '') + (unlocked ? '' : ' locked');
      node.style.marginLeft = ((Math.sin(n * 1.3) * 0.5 + 0.5) * 50) + '%';
      node.innerHTML = `<span class="node-num">${n}</span>`;
      if (unlocked) node.addEventListener('click', () => {
        state.level = n;
        $('#map-cur-level').textContent = n;
      });
      path.appendChild(node);
    });
  }

  // ---------- 启动一局 ----------
  function launchLevel(level) {
    if (state.lives <= 0) {
      alert('生命不足，请等待恢复或前往商店');
      return;
    }
    state.lives--;
    showGame();
    game.start(level);
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    // 主菜单
    $('#btn-start').addEventListener('click', () => launchLevel(state.level));
    $$('.nav-item').forEach(it => it.addEventListener('click', () => {
      const nav = it.dataset.nav;
      if (nav === 'map') showScreen('map');
      else if (nav === 'shop') alert('商店开发中 🛒');
      else if (nav === 'daily') { state.coins += 200; refreshMenu(); alert('领取每日奖励 +200 🪙'); }
      else if (nav === 'checkin') alert('今日已签到 ✅');
    }));

    // 地图
    $('#btn-map-start').addEventListener('click', () => launchLevel(state.level));
    $$('[data-back]').forEach(b => b.addEventListener('click', () => showScreen(b.dataset.back)));

    // 道具说明关闭
    $$('[data-close]').forEach(b => b.addEventListener('click', () => screens.help.classList.add('hidden')));

    // 工具栏
    $$('.tool-btn').forEach(btn => btn.addEventListener('click', () => game.useTool(btn.dataset.tool)));

    // 胜利
    $$('#screen-win [data-act]').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.act;
      if (a === 'next') { state.level = game.cfg.n + 1; launchLevel(state.level); }
      else if (a === 'replay') launchLevel(game.cfg.n);
      else showScreen('map');
    }));
    // 失败
    $('#btn-revive').addEventListener('click', () => game.revive());
    $$('#screen-lose [data-act]').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.act;
      if (a === 'replay') launchLevel(game.cfg.n);
      else { if (state.coins >= 300) state.coins -= 300; showScreen('map'); }
    }));

    // 画布指针事件
    const getPos = (e) => {
      const rect = canvas.getBoundingClientRect();
      const p = e.touches ? e.touches[0] : e;
      return { x: p.clientX - rect.left, y: p.clientY - rect.top };
    };
    const down = (e) => { if (!hud.classList.contains('hidden')) { const p = getPos(e); game.pointerDown(p.x, p.y); } };
    const move = (e) => { if (game.drag || game.activeTool) { e.preventDefault(); const p = getPos(e); game.pointerMove(p.x, p.y); } };
    const up = () => game.pointerUp();
    canvas.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    canvas.addEventListener('touchstart', (e) => { e.preventDefault(); down(e); }, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', up);
  }

  // ---------- 初始化 ----------
  window.addEventListener('load', () => {
    loadImages();
    resize();
    game = new Game();
    window.__game = game; // 调试/测试钩子
    bindEvents();
    showScreen('menu');
  });

})();
